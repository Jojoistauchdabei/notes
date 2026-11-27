#!/usr/bin/env python3
"""scraper.py — Bildungs-Content-Scraper (Physik, Mathe, Chemie, Informatik).

Sammelt Lerninhalte aus kuratierten Web-Quellen und YouTube-Transkripten und
speichert sie als JSON-Liste mit einheitlichen Metadaten.

Metadaten pro Eintrag (Schlüssel):
    subject     Fach: "Physik" | "Mathe" | "Chemie" | "Informatik" | ...
    topic       Thema innerhalb des Fachs (z. B. "Mechanik", "Analysis")
    title       Titel der Seite bzw. des Videos
    type        "web" | "video"
    url         URL der Quelle (kanonische YouTube-Watch-URL bei Videos)
    difficulty  Schwierigkeit: "einfach" | "mittel" | "schwer"

Zusätzliche Felder: text/transcript, source_site/channel, scraped_at, ...

Quellen:
    WEB_SOURCES       kuratierte Web-Seiten (leifiphysik, mathebibel,
                      chemglobe, MDN, ...)
    YOUTUBE_CHANNELS  YouTube-Kanäle; passende Lernvideos werden per
                      YouTube-Suche (Fallback: Kanal-Tab/RSS-Feed) gefunden
                      und die Transkripte über `youtube-transcript-api`
                      geholt (Lehrer Schmidt, simpleclub, Daniel Jung, ...)

Features:
    * Batch-Verarbeitung (`--batch-size`, `--batch-pause`)
    * Rate-Limiting (`--delay`, minimaler Abstand zwischen Requests;
      Retry mit exponentiellem Backoff bei 429/5xx/Fehlern, `--retries`)
    * Fortschritts-Logging (Konsole + optional `--log-file`, ETA, Zähler)
    * robuste Fehlerbehandlung pro Eintrag (Fehler werden gesammelt,
      Batch läuft weiter); Ergebnis + Fehlerliste im JSON-Output

Aufruf:
    python scraper.py                          # alles scrapen
    python scraper.py --only video             # nur YouTube-Transkripte
    python scraper.py --only web               # nur Web-Quellen
    python scraper.py --subject Physik         # nur ein Fach (wiederholbar)
    python scraper.py --batch-size 3 --delay 1.5 --max-videos-per-channel 8
    python scraper.py --url https://example.org --subject-for-custom Mathe
    python scraper.py --list-sources           # Quellen anzeigen, nichts laden

Abhängigkeiten (siehe requirements.txt):
    pip install -r requirements.txt
    -> requests, youtube-transcript-api, beautifulsoup4 (optional)
"""

from __future__ import annotations

import argparse
import html as html_module
import json
import logging
import math
import os
import re
import sys
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    import requests
except ImportError as exc:  # pragma: no cover
    sys.exit(f"Fehler: 'requests' ist nicht installiert ({exc}). "
             "Bitte `pip install -r requirements.txt`.")

try:
    from bs4 import BeautifulSoup  # type: ignore
except ImportError:  # pragma: no cover - optional
    BeautifulSoup = None  # type: ignore

logger = logging.getLogger("scraper")

# ---------------------------------------------------------------------------
# Konstanten
# ---------------------------------------------------------------------------

SUBJECT_PHYSIK = "Physik"
SUBJECT_MATHE = "Mathe"
SUBJECT_CHEMIE = "Chemie"
SUBJECT_INFORMATIK = "Informatik"
SUBJECT_UNKNOWN = "Sonstiges"

SUBJECTS = (SUBJECT_PHYSIK, SUBJECT_MATHE, SUBJECT_CHEMIE, SUBJECT_INFORMATIK)

DIFFICULTY_EASY = "einfach"
DIFFICULTY_MEDIUM = "mittel"
DIFFICULTY_HARD = "schwer"
DIFFICULTIES = (DIFFICULTY_EASY, DIFFICULTY_MEDIUM, DIFFICULTY_HARD)

TYPE_WEB = "web"
TYPE_VIDEO = "video"

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 scraper.py/1.0"
)
DEFAULT_LANGUAGES = ("de", "en")
DEFAULT_HTTP_PROXY = os.environ.get("SCRAPER_HTTP_PROXY") or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
DEFAULT_HTTPS_PROXY = os.environ.get("SCRAPER_HTTPS_PROXY") or os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
DEFAULT_INVIDIOUS_INSTANCES = (
    "https://yt.chocolatemoo53.com",
)
YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v={video_id}"
YOUTUBE_RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
YOUTUBE_OEMBED_URL = "https://www.youtube.com/oembed"

VIDEO_ID_RE = re.compile(r"^[0-9A-Za-z_-]{11}$")
CHANNEL_ID_RE = re.compile(r"^UC[0-9A-Za-z_-]{20,}$")

# Regex-Fallback, falls BeautifulSoup nicht installiert ist.
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|noscript|template|svg|iframe)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_MAIN_RE = re.compile(r"<(main|article)\b[^>]*>(.*?)</\1\s*>", re.IGNORECASE | re.DOTALL)
_WS_RE = re.compile(r"[ \t\f\v]+")
_BLANK_RE = re.compile(r"\n\s*\n+")

# ---------------------------------------------------------------------------
# Kuratierte Quellen
# ---------------------------------------------------------------------------


@dataclass
class Source:
    """Eine zu scrapende Quelle (Web-Seite oder YouTube-Video)."""

    subject: str
    topic: str
    title: str
    url: str
    type: str = TYPE_WEB  # "web" | "video"
    difficulty: str = DIFFICULTY_MEDIUM
    # YouTube-Extras
    video_id: str | None = None
    channel: str | None = None
    languages: tuple[str, ...] = DEFAULT_LANGUAGES


# Kuratierte Web-Quellen. Erweiterbar: einfach weitere Einträge anhängen.
WEB_SOURCES: list[Source] = [
    # ---------------- Physik: leifiphysik.de ----------------
    Source(SUBJECT_PHYSIK, "Mechanik / Kinematik", "Gleichförmige Bewegung",
           "https://www.leifiphysik.de/mechanik/gleichfoermige-bewegung", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_PHYSIK, "Mechanik / Kinematik", "Beschleunigte Bewegung",
           "https://www.leifiphysik.de/mechanik/beschleunigte-bewegung", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_PHYSIK, "Mechanik / Kinematik", "Kreisbewegung",
           "https://www.leifiphysik.de/mechanik/kreisbewegung", TYPE_WEB, DIFFICULTY_HARD),
    Source(SUBJECT_PHYSIK, "Mechanik / Dynamik", "Kraft und Bewegungsänderung",
           "https://www.leifiphysik.de/mechanik/kraft-und-bewegungsaenderung", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_PHYSIK, "Mechanik / Dynamik", "Kraft und Kraftarten",
           "https://www.leifiphysik.de/mechanik/kraft-und-kraftarten", TYPE_WEB, DIFFICULTY_EASY),
    Source(SUBJECT_PHYSIK, "Mechanik / Energie", "Arbeit, Energie und Leistung",
           "https://www.leifiphysik.de/mechanik/arbeit-energie-und-leistung", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_PHYSIK, "Elektrizitätslehre", "Elektrizitätslehre",
           "https://www.leifiphysik.de/elektrizitaetslehre", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_PHYSIK, "Wärmelehre", "Wärmelehre",
           "https://www.leifiphysik.de/waermelehre", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_PHYSIK, "Akustik", "Akustik",
           "https://www.leifiphysik.de/akustik", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_PHYSIK, "Optik", "Optik",
           "https://www.leifiphysik.de/optik", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_PHYSIK, "Quantenphysik", "Quantenphysik",
           "https://www.leifiphysik.de/quantenphysik", TYPE_WEB, DIFFICULTY_HARD),
    # ---------------- Mathe: mathebibel.de ----------------
    Source(SUBJECT_MATHE, "Funktionen", "Lineare Funktionen",
           "https://www.mathebibel.de/lineare-funktionen", TYPE_WEB, DIFFICULTY_EASY),
    Source(SUBJECT_MATHE, "Funktionen", "Quadratische Funktionen",
           "https://www.mathebibel.de/quadratische-funktionen", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_MATHE, "Analysis / Differentialrechnung", "Ableitung",
           "https://www.mathebibel.de/ableitung", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_MATHE, "Analysis / Differentialrechnung", "Ableitungsregeln",
           "https://www.mathebibel.de/ableitungsregeln", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_MATHE, "Analysis / Integralrechnung", "Integralrechnung",
           "https://www.mathebibel.de/integralrechnung", TYPE_WEB, DIFFICULTY_HARD),
    Source(SUBJECT_MATHE, "Trigonometrie", "Trigonometrie",
           "https://www.mathebibel.de/trigonometrie", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_MATHE, "Stochastik", "Stochastik",
           "https://www.mathebibel.de/stochastik", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_MATHE, "Analytische Geometrie", "Vektorrechnung",
           "https://www.mathebibel.de/vektorrechnung", TYPE_WEB, DIFFICULTY_MEDIUM),
    # ---------------- Chemie: chemglobe.org ----------------
    Source(SUBJECT_CHEMIE, "Allgemeine Chemie / Atombau", "Daltons Atomtheorie",
           "https://www.chemglobe.org/general/aufbaumaterie/dalton.php", TYPE_WEB, DIFFICULTY_EASY),
    Source(SUBJECT_CHEMIE, "Allgemeine Chemie / Atombau", "Der Elementbegriff",
           "https://www.chemglobe.org/general/aufbaumaterie/element.php", TYPE_WEB, DIFFICULTY_EASY),
    Source(SUBJECT_CHEMIE, "Allgemeine Chemie / Formeln", "Empirische Formeln",
           "https://www.chemglobe.org/general/formeln/empirische.php", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_CHEMIE, "Allgemeine Chemie / Atombau", "Bohrsches Atommodell",
           "https://www.chemglobe.org/general/elektroaufbau/bohr.php", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_CHEMIE, "Allgemeine Chemie / Reaktionen", "Chemische Reaktionsgleichungen",
           "https://www.chemglobe.org/general/gleichung/gleichungen.php", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_CHEMIE, "Allgemeine Chemie / Atomeigenschaften", "Ionisierungsenergie",
           "https://www.chemglobe.org/general/atomeigenschaften/ionisierung.php", TYPE_WEB, DIFFICULTY_HARD),
    Source(SUBJECT_CHEMIE, "Allgemeine Chemie / Bindung", "Elektronegativität",
           "https://www.chemglobe.org/general/chembindung/en.php", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_CHEMIE, "Organische Chemie / Stereochemie", "Chiralität",
           "https://www.chemglobe.org/organic/stereochemie/chiralitaet.php", TYPE_WEB, DIFFICULTY_HARD),
    Source(SUBJECT_CHEMIE, "Organische Chemie / Stereochemie", "R-S-Konvention",
           "https://www.chemglobe.org/organic/stereochemie/rskonvention.php", TYPE_WEB, DIFFICULTY_HARD),
    # ---------------- Informatik: MDN ----------------
    Source(SUBJECT_INFORMATIK, "Web-Entwicklung", "JavaScript",
           "https://developer.mozilla.org/de/docs/Web/JavaScript", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_INFORMATIK, "Web-Entwicklung / JavaScript", "JavaScript Guide",
           "https://developer.mozilla.org/de/docs/Web/JavaScript/Guide", TYPE_WEB, DIFFICULTY_EASY),
    Source(SUBJECT_INFORMATIK, "Web-Entwicklung / JavaScript", "JavaScript Referenz",
           "https://developer.mozilla.org/de/docs/Web/JavaScript/Reference", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_INFORMATIK, "Web-Entwicklung", "HTML",
           "https://developer.mozilla.org/de/docs/Web/HTML", TYPE_WEB, DIFFICULTY_EASY),
    Source(SUBJECT_INFORMATIK, "Web-Entwicklung", "CSS",
           "https://developer.mozilla.org/de/docs/Web/CSS", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_INFORMATIK, "Web-Entwicklung / APIs", "Web API",
           "https://developer.mozilla.org/de/docs/Web/API", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_INFORMATIK, "Web-Entwicklung / Netzwerk", "HTTP",
           "https://developer.mozilla.org/de/docs/Web/HTTP", TYPE_WEB, DIFFICULTY_MEDIUM),
    Source(SUBJECT_INFORMATIK, "Web-Entwicklung", "Lernen",
           "https://developer.mozilla.org/de/docs/Learn_web_development", TYPE_WEB, DIFFICULTY_EASY),
]

# Kuratierte YouTube-Kanäle. Lernvideos werden per YouTube-Suche je Fach
# ermittelt (Fallback: Kanal-„Videos“-Tab, dann RSS-Feed); Transkripte über
# youtube-transcript-api. `subject=None` => Fach wird aus dem Videotitel
# erraten (Fallback: `default_subject` bzw. "Sonstiges").
YOUTUBE_CHANNELS: list[dict[str, Any]] = [
    {
        "name": "Lehrer Schmidt",
        "search_name": "lehrerschmidt",
        "owner_match": ["lehrerschmidt"],
        "queries": ["Physik"],
        "subject": None,  # Physik-Kanal, aber auch Mathe -> Fach je Video erraten
        "default_subject": SUBJECT_UNKNOWN,
        "channel_id": "UCy0FxMgGUlRnkxCoNZUNRQQ",
        "channel_urls": [
            "https://www.youtube.com/@LehrerSchmidt",
            "https://www.youtube.com/c/LehrerSchmidt",
            "https://www.youtube.com/user/LehrerSchmidt",
        ],
        "difficulty": DIFFICULTY_MEDIUM,
    },
    {
        "name": "simpleclub",
        "search_name": "simpleclub",
        "owner_match": ["simpleclub"],
        "queries": ["Physik", "Mathe", "Chemie", "Informatik"],
        "subject": None,  # Multi-Fach -> Fach je Video erraten
        "channel_id": "UCdQvwubOWGRB8JyoEC7lSbA",  # simpleclub - Die Lernapp
        "channel_urls": [
            "https://www.youtube.com/channel/UCdQvwubOWGRB8JyoEC7lSbA",
        ],
        "difficulty": DIFFICULTY_EASY,
    },
    {
        "name": "Daniel Jung",
        "search_name": "daniel jung",
        "owner_match": ["daniel jung"],
        "queries": ["Mathe"],
        "subject": SUBJECT_MATHE,
        "channel_id": "UC05b08HRB0KOh6ouOLz96IA",
        "channel_urls": [
            "https://www.youtube.com/@MathebyDanielJung",
            "https://www.youtube.com/mattam66",
            "https://www.youtube.com/user/mattam66",
            "https://www.youtube.com/c/MathebyDanielJung",
        ],
        "difficulty": DIFFICULTY_MEDIUM,
    },
]

# Keyword-Listen zum Erraten von Fach/Thema bei freien Quellen (YouTube etc.).
SUBJECT_KEYWORDS: dict[str, list[str]] = {
    SUBJECT_INFORMATIK: [
        "informatik", "programmier", "code", "javascript", "python", "java",
        "html", "css", "algorithmus", "datenbank", "netzwerk", "software",
        "computer", "api", "web", "typescript", "react", "linux",
    ],
    SUBJECT_CHEMIE: [
        "chemie", "chemisch", "reaktion", "säure", "saeure", "base",
        "molekül", "molekuel", "bindung", "organisch", "anorganisch",
        "stöchiometrie", "stoechiometrie", "lösung", "loesung", "element",
        "redox", "elektrochemie", "kohlenwasserstoff", "alkan", "alken",
        "alkin", "ester", "polymer", "katalys", "gasgleichung", "pse",
    ],
    SUBJECT_PHYSIK: [
        "physik", "mechanik", "kraft", "energie", "elektro", "magnet",
        "optik", "welle", "schwingung", "quanten", "thermodynamik", "wärme",
        "waerme", "schwerkraft", "licht", "strahlung", "spannung", "strom",
        "ohm", "newton", "akustik", "feld", "atom", "kernphysik", "impuls",
        "bewegung", "geschwindigkeit", "beschleunigung", "reibung",
        "gravitation", "druck", "auftrieb", "ladung", "widerstand",
        "kondensator", "spule", "brechung", "reflexion", "linse", "spiegel",
        "schall", "frequenz", "wellenlänge", "radioaktiv", "teilchen",
    ],
    SUBJECT_MATHE: [
        "mathe", "mathematik", "ableitung", "integral", "funktion",
        "gleichung", "vektor", "matrix", "wahrscheinlichkeit", "stochastik",
        "geometrie", "trigonometrie", "sinus", "cosinus", "tangens", "bruch",
        "wurzel", "potenz", "polynom", "kurvendiskussion", "grenzwert",
        "analysis", "steigung", "linear", "quadratisch", "binomisch",
    ],
}

TOPIC_KEYWORDS: dict[str, dict[str, list[str]]] = {
    SUBJECT_PHYSIK: {
        "Mechanik": ["mechanik", "kraft", "bewegung", "newton", "reibung", "impuls", "energie", "arbeit", "kreisbewegung", "fall", "wurf"],
        "Elektrizitätslehre": ["elektr", "strom", "spannung", "ohm", "schaltung", "magnet", "feld", "kondensator", "induktion"],
        "Optik": ["optik", "licht", "brechung", "reflexion", "linsen", "strahl"],
        "Akustik": ["akustik", "schall", "welle", "schwingung", "frequenz"],
        "Wärmelehre": ["wärme", "waerme", "temperatur", "thermo", "entropie", "gasgleichung"],
        "Quantenphysik": ["quanten", "photon", "elektron", "atom", "kern", "spektrum"],
        "Astronomie": ["astronomie", "sonne", "mond", "planet", "stern", "kosmos"],
    },
    SUBJECT_MATHE: {
        "Analysis": ["ableit", "integral", "grenzwert", "kurvendiskussion", "steigung", "extrem", "analysis", "tangente"],
        "Funktionen": ["funktion", "linear", "quadratisch", "ganzrational", "exponential", "logarithmus", "wurzel", "potenz"],
        "Algebra": ["gleichung", "ungleichung", "term", "binomisch", "bruch", "potenzgesetz", "umformen"],
        "Stochastik": ["wahrscheinlichkeit", "stochastik", "statistik", "verteilung", "kombinatorik", "zufall"],
        "Geometrie": ["geometrie", "dreieck", "kreis", "vektor", "matrix", "fläche", "flaeche", "volumen", "winkel", "pythagoras", "trigonometrie", "sinus", "cosinus"],
    },
    SUBJECT_CHEMIE: {
        "Organische Chemie": ["organisch", "kohlenwasserstoff", "alkan", "alken", "alkin", "ester", "aldehyd", "keton", "polymer", "benzol", "nomenklatur"],
        "Anorganische Chemie": ["anorganisch", "säure", "saeure", "base", "salz", "metall", "halogen", "redox"],
        "Physikalische Chemie": ["gleichgewicht", "kinetik", "thermo", "elektrochemie", "lösung", "loesung", "stoechiometrie", "stöchiometrie"],
        "Allgemeine Chemie": ["aufbau", "atom", "molekül", "molekuel", "bindung", "element", "pse", "formel", "reaktion"],
    },
    SUBJECT_INFORMATIK: {
        "Programmierung": ["programmier", "code", "python", "java", "javascript", "funktion", "variable", "schleife", "klasse", "objekt"],
        "Web-Entwicklung": ["html", "css", "web", "javascript", "api", "http", "frontend", "backend"],
        "Datenbanken": ["datenbank", "sql", "tabelle", "query"],
        "Algorithmen & Datenstrukturen": ["algorithmus", "datenstruktur", "sortier", "graph", "komplexität", "komplexitaet", "baum", "liste"],
        "Netzwerke": ["netzwerk", "tcp", "ip", "protokoll", "router", "http"],
        "Software & Systeme": ["software", "betriebssystem", "linux", "computer", "hardware", "sicherheit"],
    },
}

# ---------------------------------------------------------------------------
# Fortschritts-Logging
# ---------------------------------------------------------------------------


def setup_logging(log_file: str | None = None, verbose: bool = False) -> None:
    """Konfiguriert Fortschritts-Logging (Konsole + optional Log-Datei)."""
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s [%(levelname)s] %(message)s"
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if log_file:
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(level=level, format=fmt, handlers=handlers, force=True)


def _fmt_seconds(seconds: float) -> str:
    seconds = max(0, int(seconds))
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {sec:02d}s"
    if minutes:
        return f"{minutes}m {sec:02d}s"
    return f"{sec}s"


def log_progress(done: int, total: int, ok: int, failed: int, started_at: float, current: str) -> None:
    """Einheitlicher Fortschritts-Log-Eintrag mit Zähler, %, Laufzeit und ETA."""
    elapsed = time.monotonic() - started_at
    pct = (done / total * 100.0) if total else 100.0
    rate = (done / elapsed) if elapsed > 0 and done else 0.0
    remaining = ((total - done) / rate) if rate > 0 else 0.0
    logger.info(
        "Fortschritt %d/%d (%.1f%%) | ok=%d fehler=%d | vergangen=%s | ETA=%s | %s",
        done, total, pct, ok, failed, _fmt_seconds(elapsed), _fmt_seconds(remaining), current,
    )


# ---------------------------------------------------------------------------
# Rate-Limiting & Retry
# ---------------------------------------------------------------------------


class RateLimiter:
    """Sorgt für einen Mindestabstand zwischen Requests (Rate-Limiting)."""

    def __init__(self, min_interval_seconds: float = 1.0) -> None:
        self.min_interval = max(0.0, float(min_interval_seconds))
        self._last_request_at = 0.0

    def wait(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_request_at
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last_request_at = time.monotonic()


def with_retries(
    fn: Callable[[], Any],
    retries: int = 3,
    backoff_base: float = 1.5,
    description: str = "",
    rate_limiter: RateLimiter | None = None,
    retry_if: Callable[[Exception], bool] | None = None,
) -> Any:
    """Führt fn aus; Retry mit exponentiellem Backoff bei Fehlern.

    `retry_if` kann bestimmte (permanente) Fehler vom Retry ausnehmen.
    """
    attempts = max(1, retries + 1)
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            if rate_limiter is not None:
                rate_limiter.wait()
            return fn()
        except Exception as exc:  # noqa: BLE001 - bewusst breit, pro Versuch
            last_exc = exc
            if attempt >= attempts or (retry_if is not None and not retry_if(exc)):
                break
            sleep_for = backoff_base ** (attempt - 1)
            logger.warning(
                "Versuch %d/%d fehlgeschlagen%s: %s — Retry in %.1fs",
                attempt, attempts, f" ({description})" if description else "",
                _short_error(exc), sleep_for,
            )
            time.sleep(sleep_for)
    assert last_exc is not None
    raise last_exc


def _short_error(exc: Exception, limit: int = 160) -> str:
    msg = f"{type(exc).__name__}: {exc}".strip()
    return msg if len(msg) <= limit else msg[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def build_session(user_agent: str = DEFAULT_USER_AGENT) -> requests.Session:
    """requests-Session mit Browser-UA + YouTube-Consent-Cookies."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": user_agent,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })
    # GDPR-Consent umgehen, sonst redirectet YouTube auf consent.youtube.com.
    session.cookies.set("CONSENT", "YES+cb.20210328-17-p0.en+FX+999", domain=".youtube.com")
    session.cookies.set("SOCS", "CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg", domain=".youtube.com")
    return session


def http_get(
    session: requests.Session,
    url: str,
    *,
    timeout: float = 20.0,
    rate_limiter: RateLimiter | None = None,
    retries: int = 3,
    **kwargs: Any,
) -> requests.Response:
    """GET mit Rate-Limiting, Retry/Backoff und Fehlerstatus-Prüfung."""

    def _do() -> requests.Response:
        response = session.get(url, timeout=timeout, **kwargs)
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("Retry-After")
            hint = f" (Retry-After: {retry_after})" if retry_after else ""
            raise requests.HTTPError(
                f"HTTP {response.status_code} für {url}{hint}", response=response
            )
        response.raise_for_status()
        return response

    def _retryable(exc: Exception) -> bool:
        # 4xx (außer 429) sind endgültig; 429/5xx/Netzwerkfehler werden wiederholt.
        if isinstance(exc, requests.HTTPError) and exc.response is not None:
            status = exc.response.status_code
            return status == 429 or status >= 500
        return True

    return with_retries(
        _do, retries=retries, description=url,
        rate_limiter=rate_limiter, retry_if=_retryable,
    )


# ---------------------------------------------------------------------------
# HTML -> Text
# ---------------------------------------------------------------------------


def _clean_text(text: str) -> str:
    text = html_module.unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    text = _WS_RE.sub(" ", text)
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join(line for line in lines if line)
    text = _BLANK_RE.sub("\n\n", text)
    return text.strip()


def extract_title(html_text: str, fallback: str = "") -> str:
    """Titel aus og:title / <title>, sonst Fallback."""
    if BeautifulSoup is not None:
        soup = BeautifulSoup(html_text, "html.parser")
        og = soup.find("meta", property="og:title")
        if og and og.get("content"):
            return _clean_text(str(og["content"]))
        if soup.title and soup.title.string:
            return _clean_text(soup.title.string)
    match = _TITLE_RE.search(html_text)
    if match:
        return _clean_text(match.group(1))
    return fallback


def extract_text(html_text: str) -> str:
    """Extrahiert den Haupttext aus HTML (BeautifulSoup, sonst Regex-Fallback)."""
    if BeautifulSoup is not None:
        soup = BeautifulSoup(html_text, "html.parser")
        for tag in soup(["script", "style", "noscript", "template", "svg", "iframe", "header", "footer", "nav", "form"]):
            tag.decompose()
        root = soup.find("main") or soup.find("article") or soup.body or soup
        return _clean_text(root.get_text("\n"))
    # Regex-Fallback
    text = _COMMENT_RE.sub(" ", html_text)
    text = _SCRIPT_STYLE_RE.sub(" ", text)
    main_match = _MAIN_RE.search(text)
    if main_match:
        text = main_match.group(2)
    text = _TAG_RE.sub("\n", text)
    return _clean_text(text)


def source_site(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.")


# ---------------------------------------------------------------------------
# Fach/Thema erraten
# ---------------------------------------------------------------------------


def _normalize(text: str) -> str:
    return text.lower()


def infer_subject(text: str, default: str = SUBJECT_UNKNOWN) -> str:
    """Errät das Fach anhand von Keywords im Text."""
    haystack = _normalize(text)
    scores: dict[str, int] = {}
    for subject, keywords in SUBJECT_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in haystack)
        if score:
            scores[subject] = score
    if not scores:
        return default
    return max(scores.items(), key=lambda kv: (kv[1], kv[0]))[0]


def infer_topic(subject: str, text: str, default: str = "Allgemein") -> str:
    """Errät das Thema innerhalb eines Fachs anhand von Keywords."""
    haystack = _normalize(text)
    topics = TOPIC_KEYWORDS.get(subject, {})
    best_topic, best_score = default, 0
    for topic, keywords in topics.items():
        score = sum(1 for kw in keywords if kw in haystack)
        if score > best_score:
            best_topic, best_score = topic, score
    return best_topic


def canonical_subject(subject: str | None) -> str:
    if not subject:
        return SUBJECT_UNKNOWN
    for known in SUBJECTS:
        if subject.strip().lower() == known.lower():
            return known
    aliases = {
        "physics": SUBJECT_PHYSIK,
        "math": SUBJECT_MATHE, "mathematik": SUBJECT_MATHE, "mathematics": SUBJECT_MATHE,
        "chemistry": SUBJECT_CHEMIE,
        "informatics": SUBJECT_INFORMATIK, "computer science": SUBJECT_INFORMATIK, "cs": SUBJECT_INFORMATIK,
    }
    return aliases.get(subject.strip().lower(), subject.strip())


# ---------------------------------------------------------------------------
# YouTube
# ---------------------------------------------------------------------------


def extract_video_id(url_or_id: str) -> str | None:
    """Extrahiert die 11-stellige Video-ID aus YouTube-URLs oder Roh-IDs."""
    value = url_or_id.strip()
    if VIDEO_ID_RE.match(value):
        return value
    parsed = urlparse(value if "://" in value else f"https://{value}")
    host = parsed.netloc.lower()
    path = parsed.path or ""
    # https://www.youtube.com/watch?v=ID
    query_v = parse_qs(parsed.query).get("v")
    if query_v and VIDEO_ID_RE.match(query_v[0]):
        return query_v[0]
    # https://youtu.be/ID , /embed/ID , /shorts/ID , /live/ID , /v/ID
    match = re.search(r"/(?:embed|shorts|live|v)/([0-9A-Za-z_-]{11})", path)
    if match:
        return match.group(1)
    if host.endswith("youtu.be"):
        candidate = path.lstrip("/").split("/")[0].split("?")[0]
        if VIDEO_ID_RE.match(candidate):
            return candidate
    # Generisch: letztes 11-stelliges Segment
    for segment in reversed(path.split("/")):
        if VIDEO_ID_RE.match(segment):
            return segment
    return None


def canonical_video_url(video_id: str) -> str:
    return YOUTUBE_WATCH_URL.format(video_id=video_id)


def find_channel_id(session: requests.Session, channel_url: str, rate_limiter: RateLimiter | None, retries: int) -> str | None:
    """Findet die YouTube-Channel-ID einer Kanal-URL (HTML-Scraping)."""
    value = channel_url.strip()
    if CHANNEL_ID_RE.match(value):
        return value
    # https://www.youtube.com/channel/UCxxxx -> direkt übernehmen
    parsed = urlparse(value if "://" in value else f"https://{value}")
    path_match = re.search(r"/channel/(UC[0-9A-Za-z_-]+)", parsed.path)
    if path_match:
        return path_match.group(1)
    response = http_get(session, value, rate_limiter=rate_limiter, retries=retries)
    html_text = response.text
    # Bevorzugt: kanonische Kanal-URL, externalId, og:url; dann generische IDs.
    for pattern in (
        r'"externalId":"(UC[0-9A-Za-z_-]+)"',
        r'rel="canonical" href="[^"]*/channel/(UC[0-9A-Za-z_-]+)"',
        r'og:url" content="[^"]*/channel/(UC[0-9A-Za-z_-]+)"',
        r'"channelId":"(UC[0-9A-Za-z_-]+)"',
        r'"browseId":"(UC[0-9A-Za-z_-]+)"',
        r"channel_id=(UC[0-9A-Za-z_-]+)",
        r"channel/(UC[0-9A-Za-z_-]+)",
    ):
        match = re.search(pattern, html_text)
        if match:
            return match.group(1)
    return None


def _walk_json(node: Any, key: str) -> Iterable[dict[str, Any]]:
    """Rekursiv alle verschachtelten Objekte mit dem Schlüssel `key` finden."""
    if isinstance(node, dict):
        if key in node and isinstance(node[key], dict):
            yield node[key]
        for value in node.values():
            yield from _walk_json(value, key)
    elif isinstance(node, list):
        for value in node:
            yield from _walk_json(value, key)


def discover_channel_videos_via_tab(
    session: requests.Session,
    channel_id: str,
    limit: int,
    rate_limiter: RateLimiter | None,
    retries: int,
) -> list[dict[str, str]]:
    """Liest Videos aus dem „Videos“-Tab eines Kanals (ytInitialData).

    Liefert mehr und längere Videos als der RSS-Feed und enthält keine Shorts.
    """
    response = http_get(
        session, f"https://www.youtube.com/channel/{channel_id}/videos",
        rate_limiter=rate_limiter, retries=retries,
    )
    html_text = response.text
    match = re.search(r"var ytInitialData = (\{.*?\});</script>", html_text, re.DOTALL)
    if not match:
        match = re.search(r'ytInitialData"\]\s*=\s*(\{.*?\});', html_text, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []

    entries: list[dict[str, str]] = []
    seen: set[str] = set()

    # Aktuelles Layout: lockupViewModel {contentId, metadata.title.content}
    for lockup in _walk_json(data, "lockupViewModel"):
        if lockup.get("contentType") not in (None, "LOCKUP_CONTENT_TYPE_VIDEO"):
            continue
        video_id = lockup.get("contentId")
        if not video_id or not VIDEO_ID_RE.match(str(video_id)) or video_id in seen:
            continue
        title_obj = lockup.get("metadata", {}).get("lockupMetadataViewModel", {}).get("title", {})
        title = title_obj.get("content") if isinstance(title_obj, dict) else ""
        seen.add(video_id)
        entries.append({"video_id": video_id, "title": str(title or "").strip()})
        if len(entries) >= limit:
            return entries

    # Älteres Layout: videoRenderer {videoId, title.runs[]}
    for renderer in _walk_json(data, "videoRenderer"):
        video_id = renderer.get("videoId")
        if not video_id or not VIDEO_ID_RE.match(str(video_id)) or video_id in seen:
            continue
        runs = renderer.get("title", {}).get("runs", [])
        title = "".join(str(run.get("text", "")) for run in runs)
        seen.add(video_id)
        entries.append({"video_id": video_id, "title": title.strip()})
        if len(entries) >= limit:
            break
    return entries


def search_channel_videos(
    session: requests.Session,
    query: str,
    owner_matches: Sequence[str],
    limit: int,
    rate_limiter: RateLimiter | None,
    retries: int,
    keywords: Sequence[str] = (),
) -> list[dict[str, str]]:
    """Sucht YouTube-Videos und behält nur Treffer des gewünschten Kanals.

    YouTube-Suche liefert auch thematisch passende, ältere Lernvideos —
    anders als der RSS-Feed, der nur die letzten Uploads enthält. Treffer mit
    Fach-Keywords im Titel werden bevorzugt (z. B. Mathe statt KI-Talk).
    """
    response = http_get(
        session, "https://www.youtube.com/results",
        params={"search_query": query},
        rate_limiter=rate_limiter, retries=retries,
    )
    html_text = response.text
    match = re.search(r"var ytInitialData = (\{.*?\});</script>", html_text, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []

    owners = [owner.lower() for owner in owner_matches if owner]
    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    for renderer in _walk_json(data, "videoRenderer"):
        video_id = renderer.get("videoId")
        if not video_id or not VIDEO_ID_RE.match(str(video_id)) or video_id in seen:
            continue
        owner = "".join(
            str(run.get("text", "")) for run in renderer.get("ownerText", {}).get("runs", [])
        ).strip()
        owner_lower = owner.lower()
        if owners and not any(candidate in owner_lower for candidate in owners):
            continue
        title = "".join(
            str(run.get("text", "")) for run in renderer.get("title", {}).get("runs", [])
        ).strip()
        seen.add(video_id)
        entries.append({"video_id": video_id, "title": title, "channel": owner})
        if len(entries) >= limit * 2:
            break

    if keywords:
        def _score(entry: dict[str, str]) -> int:
            haystack = entry["title"].lower()
            return sum(1 for keyword in keywords if keyword in haystack)

        entries.sort(key=_score, reverse=True)  # stabil: Relevanzreihenfolge bleibt bei Gleichstand
    return entries[:limit]


def discover_channel_videos(
    session: requests.Session,
    channel: dict[str, Any],
    limit: int,
    rate_limiter: RateLimiter | None,
    retries: int,
) -> list[dict[str, str]]:
    """Findet Lernvideos eines Kanals.

    Reihenfolge: gezielte YouTube-Suche je Fach (beste Trefferqualität),
    „Videos“-Tab des Kanals, öffentlicher RSS-Feed.
    """
    channel_id = channel.get("channel_id")
    queries = [str(q) for q in channel.get("queries", []) if str(q).strip()]
    owner_matches = channel.get("owner_match") or [channel.get("name", "")]
    search_name = channel.get("search_name") or channel.get("name", "")

    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    if queries:
        per_query = max(1, math.ceil(limit / len(queries)))
        for subject_query in queries:
            search_query = f"{search_name} {subject_query}".strip()
            keywords = SUBJECT_KEYWORDS.get(canonical_subject(subject_query), [])
            try:
                found = search_channel_videos(
                    session, search_query, owner_matches, per_query,
                    rate_limiter, retries, keywords=keywords,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("YouTube-Suche '%s' fehlgeschlagen: %s", search_query, _short_error(exc))
                continue
            for item in found:
                if item["video_id"] in seen:
                    continue
                seen.add(item["video_id"])
                entries.append(item)
                if len(entries) >= limit:
                    return entries
        if entries:
            return entries
        logger.debug("YouTube-Suche für '%s' ohne Treffer — nutze Kanal-Tab", channel.get("name"))

    if channel_id:
        try:
            videos = discover_channel_videos_via_tab(
                session, channel_id, limit, rate_limiter, retries
            )
            if videos:
                return videos
            logger.debug("Videos-Tab für %s leer — nutze RSS-Feed", channel_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Videos-Tab für %s nicht lesbar (%s) — nutze RSS-Feed",
                           channel_id, _short_error(exc))

    if not channel_id:
        return []

    response = http_get(
        session, YOUTUBE_RSS_URL.format(channel_id=channel_id),
        rate_limiter=rate_limiter, retries=retries,
    )
    xml_text = response.text
    entries: list[dict[str, str]] = []
    # <entry>...<yt:videoId>..</yt:videoId><title>..</title>...</entry>
    for entry_match in re.finditer(r"<entry>(.*?)</entry>", xml_text, re.DOTALL):
        entry = entry_match.group(1)
        vid_match = re.search(r"<yt:videoId>([0-9A-Za-z_-]+)</yt:videoId>", entry)
        if not vid_match:
            continue
        # YouTube-Shorts überspringen (kein vollständiges Transkript-Material).
        if re.search(r'<link rel="alternate" href="[^"]*/shorts/', entry):
            continue
        title_match = re.search(r"<title>(.*?)</title>", entry, re.DOTALL)
        title = _clean_text(title_match.group(1)) if title_match else ""
        entries.append({"video_id": vid_match.group(1), "title": title})
        if len(entries) >= limit:
            break
    return entries


def fetch_video_title(
    session: requests.Session,
    video_id: str,
    rate_limiter: RateLimiter | None,
    retries: int,
) -> str | None:
    """Videotitel über YouTube-oEmbed (kein API-Key nötig)."""
    try:
        response = http_get(
            session, YOUTUBE_OEMBED_URL,
            params={"url": canonical_video_url(video_id), "format": "json"},
            rate_limiter=rate_limiter, retries=retries,
        )
        data = response.json()
        title = data.get("title")
        return str(title).strip() if title else None
    except Exception as exc:  # noqa: BLE001
        logger.debug("oEmbed-Titel für %s nicht verfügbar: %s", video_id, _short_error(exc))
        return None


def _is_permanent_transcript_error(exc: Exception) -> bool:
    """Fehler, bei denen ein Retry sinnlos ist (kein Transkript vorhanden etc.)."""
    return type(exc).__name__ in {
        "NoTranscriptFound", "TranscriptsDisabled", "VideoUnavailable",
        "InvalidVideoId", "AgeRestricted", "VideoUnplayable", "NotTranslatable",
        "IpBlocked", "RequestBlocked",
    }


_VTT_TIMING_RE = re.compile(r"(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})")
_VTT_TAG_RE = re.compile(r"<[^>]+>")
_VTT_NOTE_RE = re.compile(r"^(NOTE|STYLE|REGION)\b", re.IGNORECASE)


def _parse_vtt(text: str) -> list[dict[str, Any]]:
    """Parst WebVTT-Text in einfache Snippet-Dicts (text,start,duration)."""
    # UTF-8 BOM + Zeilenenden normalisieren
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    snippets: list[dict[str, Any]] = []
    blocks = re.split(r"\n\s*\n", text)
    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        if lines[0].strip().startswith("WEBVTT") or _VTT_NOTE_RE.match(lines[0].strip()):
            continue
        # optionale Cue-ID entfernen
        while lines and "-->" not in lines[0] and not _VTT_TIMING_RE.search(lines[0]):
            # kann cue id sein
            if len(lines) == 1:
                lines = []
                break
            lines = lines[1:]
        if not lines:
            continue
        timing_line = lines[0]
        m = _VTT_TIMING_RE.search(timing_line)
        if not m:
            continue
        sh, sm, ss, sms, eh, em, es, ems = m.groups()
        start = int(sh or 0) * 3600 + int(sm) * 60 + int(ss) + int(sms) / 1000
        end = int(eh or 0) * 3600 + int(em) * 60 + int(es) + int(ems) / 1000
        body_lines = lines[1:]
        body = " ".join(_VTT_TAG_RE.sub("", line) for line in body_lines)
        body = _clean_text(body)
        if not body:
            continue
        snippets.append({"text": body, "start": start, "duration": max(0.0, end - start)})
    return snippets


def _build_youtube_api(proxy: str | None = None) -> Any:
    """Erstellt YouTubeTranscriptApi; optional mit HTTP(S)-Proxy."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "youtube-transcript-api ist nicht installiert. "
            "Bitte `pip install youtube-transcript-api`."
        ) from exc

    proxy_config = None
    if proxy:
        try:
            from youtube_transcript_api.proxies import GenericProxyConfig  # type: ignore

            proxy_config = GenericProxyConfig(http_url=proxy, https_url=proxy)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Proxy-Konfiguration für youtube-transcript-api fehlgeschlagen: %s", _short_error(exc))
            proxy_config = None
    return YouTubeTranscriptApi(proxy_config=proxy_config)


def fetch_youtube_transcript_via_invidious(
    video_id: str,
    languages: Sequence[str] = DEFAULT_LANGUAGES,
    session: requests.Session | None = None,
    instances: Sequence[str] = DEFAULT_INVIDIOUS_INSTANCES,
) -> dict[str, Any]:
    """Fallback: Transkript über Invidious-Captions-API (WebVTT).

    Nützlich, wenn die direkte YouTube-Transcript-API per IP blockiert wird.
    """
    sess = session or build_session()
    preferred = [lang.strip() for lang in languages if lang.strip()] or list(DEFAULT_LANGUAGES)
    last_error: Exception | None = None

    for base in instances:
        base = base.rstrip("/")
        try:
            listing = sess.get(f"{base}/api/v1/captions/{video_id}", timeout=20)
            if listing.status_code >= 400:
                last_error = RuntimeError(f"Invidious captions listing HTTP {listing.status_code} ({base})")
                continue
            try:
                payload = listing.json()
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                continue
            captions = payload.get("captions", []) if isinstance(payload, dict) else []
            if not captions:
                last_error = RuntimeError(f"Invidious: keine Captions für {video_id} ({base})")
                continue

            # Sprache auswählen: bevorzugte Sprache, sonst erste.
            chosen = None
            for lang in preferred:
                for cap in captions:
                    code = str(cap.get("languageCode") or cap.get("language_code") or "")
                    if code == lang or code.startswith((lang + "-", lang + "_")):
                        chosen = cap
                        break
                if chosen:
                    break
            if chosen is None:
                chosen = captions[0]

            code = str(chosen.get("languageCode") or chosen.get("language_code") or "de")
            lang = code.split("-")[0]
            vtt_resp = sess.get(f"{base}/api/v1/captions/{video_id}", params={"lang": lang}, timeout=30)
            if vtt_resp.status_code >= 400:
                last_error = RuntimeError(f"Invidious VTT HTTP {vtt_resp.status_code} ({base})")
                continue
            snippets = _parse_vtt(vtt_resp.text)
            if not snippets:
                last_error = RuntimeError(f"Invidious VTT leer/unparsebar ({base})")
                continue
            text_out = "\n".join(s["text"] for s in snippets).strip()
            return {
                "text": text_out,
                "language": lang,
                "language_name": str(chosen.get("label") or lang),
                "is_generated": "auto" in str(chosen.get("label", "")).lower(),
                "segment_count": len(snippets),
                "source": f"invidious:{base}",
            }
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            continue

    raise RuntimeError(f"Invidious-Fallback fehlgeschlagen für {video_id}: {_short_error(last_error) if last_error else 'unbekannt'}")


def fetch_youtube_transcript(
    video_id: str,
    languages: Sequence[str] = DEFAULT_LANGUAGES,
    proxy: str | None = None,
    session: requests.Session | None = None,
) -> dict[str, Any]:
    """Holt das Transkript eines Videos via youtube-transcript-api.

    Bevorzugt manuell erstellte Transkripte in den gewünschten Sprachen,
    dann generierte, dann beliebige verfügbare Sprachen. Bei Fehlern
    wird auf Invidious-Captions zurückgefallen.
    """
    preferred = [lang.strip() for lang in languages if lang.strip()] or list(DEFAULT_LANGUAGES)
    try:
        api = _build_youtube_api(proxy=proxy)
    except Exception as exc:  # noqa: BLE001
        logger.warning("youtube-transcript-api nicht nutzbar (%s), versuche Invidious", _short_error(exc))
        return fetch_youtube_transcript_via_invidious(video_id, preferred, session=session)

    try:
        transcript_list = api.list(video_id)

        transcript = None
        finders = (
            transcript_list.find_manually_created_transcript,
            transcript_list.find_transcript,
            transcript_list.find_generated_transcript,
        )
        for finder in finders:
            try:
                transcript = finder(preferred)
                break
            except Exception:  # noqa: BLE001, S112 - NoTranscriptFound etc.
                continue
        if transcript is None:
            available = list(transcript_list)
            if not available:
                raise RuntimeError(f"Kein Transkript verfügbar für Video {video_id}")
            transcript = available[0]

        fetched = transcript.fetch()
        snippets = getattr(fetched, "snippets", None) or list(fetched)
        pieces: list[str] = []
        for snippet in snippets:
            text = getattr(snippet, "text", None)
            if text is None and isinstance(snippet, dict):
                text = snippet.get("text")
            if text and str(text).strip():
                pieces.append(str(text).strip())
        full_text = "\n".join(pieces).strip()
        return {
            "text": full_text,
            "language": getattr(fetched, "language_code", None) or transcript.language_code,
            "language_name": getattr(fetched, "language", None),
            "is_generated": bool(getattr(fetched, "is_generated", transcript.is_generated)),
            "segment_count": len(pieces),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("Direktes YouTube-Transcript fehlgeschlagen für %s (%s), versuche Invidious", video_id, _short_error(exc))
        return fetch_youtube_transcript_via_invidious(video_id, preferred, session=session)


# ---------------------------------------------------------------------------
# Scraping einer Quelle
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()  # noqa: UP017 - Python-3.10-Kompatibilität


def scrape_web_source(
    source: Source,
    session: requests.Session,
    rate_limiter: RateLimiter | None = None,
    retries: int = 3,
    timeout: float = 20.0,
) -> dict[str, Any]:
    """Scrapt eine Web-Quelle; liefert Metadaten + extrahierten Text."""
    response = http_get(session, source.url, timeout=timeout, rate_limiter=rate_limiter, retries=retries)
    html_text = response.text
    title = extract_title(html_text, fallback=source.title) or source.title
    text = extract_text(html_text)

    # Bei freien Quellen (z. B. --url) Fach/Thema aus dem Inhalt erraten.
    subject = source.subject
    topic = source.topic
    if subject == SUBJECT_UNKNOWN:
        sample = f"{title}\n{text[:3000]}"
        subject = infer_subject(sample, default=SUBJECT_UNKNOWN)
        if not topic or topic == "Allgemein":
            topic = infer_topic(subject, sample, default="Allgemein")

    return {
        # --- Pflicht-Metadaten ---
        "subject": subject,
        "topic": topic,
        "title": title,
        "type": TYPE_WEB,
        "url": response.url or source.url,
        "difficulty": source.difficulty,
        # --- Zusatzinfos ---
        "source_url": source.url,
        "source_site": source_site(source.url),
        "text": text,
        "word_count": len(text.split()),
        "scraped_at": _now_iso(),
    }


def scrape_video_source(
    source: Source,
    session: requests.Session,
    rate_limiter: RateLimiter | None = None,
    retries: int = 3,
    languages: Sequence[str] = DEFAULT_LANGUAGES,
    fallback_title: str | None = None,
    youtube_proxy: str | None = None,
) -> dict[str, Any]:
    """Scrapt ein YouTube-Video; liefert Metadaten + Transkript."""
    video_id = source.video_id or extract_video_id(source.url)
    if not video_id:
        raise ValueError(f"Keine YouTube-Video-ID aus URL ableitbar: {source.url}")

    url = canonical_video_url(video_id)
    langs = tuple(source.languages or languages)

    try:
        transcript = with_retries(
            lambda: fetch_youtube_transcript(video_id, languages=langs, proxy=youtube_proxy, session=session),
            retries=retries,
            description=f"YouTube-Transkript {video_id}",
            rate_limiter=rate_limiter,
            retry_if=lambda exc: not _is_permanent_transcript_error(exc),
        )
    except Exception as exc:  # noqa: BLE001
        # Bei direktem API-Fehler (z.B. IpBlocked) Invidious-Fallback versuchen.
        logger.warning("Direktes Transcript fehlgeschlagen für %s (%s), versuche Invidious", video_id, _short_error(exc))
        transcript = fetch_youtube_transcript_via_invidious(video_id, langs, session=session)

    title = source.title or fallback_title
    if not title or title == video_id:
        title = fetch_video_title(session, video_id, rate_limiter, retries) or title or video_id

    subject = source.subject
    topic = source.topic
    title_text = title or ""
    if not subject or subject == SUBJECT_UNKNOWN:
        subject = infer_subject(f"{source.channel or ''} {title_text}", default=SUBJECT_UNKNOWN)
    if not topic or topic == "Allgemein":
        topic = infer_topic(subject, title_text, default=topic or "Allgemein")

    return {
        # --- Pflicht-Metadaten ---
        "subject": subject,
        "topic": topic,
        "title": title_text or video_id,
        "type": TYPE_VIDEO,
        "url": url,
        "difficulty": source.difficulty,
        # --- Zusatzinfos ---
        "video_id": video_id,
        "channel": source.channel,
        "source_site": "youtube.com",
        "transcript": transcript["text"],
        "text": transcript["text"],
        "transcript_language": transcript["language"],
        "transcript_is_generated": transcript["is_generated"],
        "transcript_segments": transcript["segment_count"],
        "word_count": len(transcript["text"].split()),
        "scraped_at": _now_iso(),
    }


def scrape_one(
    source: Source,
    session: requests.Session,
    rate_limiter: RateLimiter | None,
    retries: int,
    languages: Sequence[str],
) -> dict[str, Any]:
    if source.type == TYPE_VIDEO:
        return scrape_video_source(
            source, session, rate_limiter=rate_limiter,
            retries=retries, languages=languages,
        )
    return scrape_web_source(source, session, rate_limiter=rate_limiter, retries=retries)


# ---------------------------------------------------------------------------
# Quellen-Aufbau
# ---------------------------------------------------------------------------


def expand_youtube_channels(
    session: requests.Session,
    channels: Sequence[dict[str, Any]],
    max_videos_per_channel: int,
    rate_limiter: RateLimiter | None,
    retries: int,
    languages: Sequence[str],
) -> list[Source]:
    """Erweitert kuratierte YouTube-Kanäle in einzelne Video-Quellen."""
    sources: list[Source] = []
    for channel in channels:
        name = channel["name"]
        subject = channel.get("subject")
        default_subject = channel.get("default_subject", SUBJECT_UNKNOWN)
        difficulty = channel.get("difficulty", DIFFICULTY_MEDIUM)
        channel_id = channel.get("channel_id")

        if not channel_id:
            # Kanal-ID über Kandidaten-URLs auflösen.
            for candidate_url in channel.get("channel_urls", []):
                try:
                    channel_id = find_channel_id(session, candidate_url, rate_limiter, retries)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Kanal-Auflösung fehlgeschlagen (%s): %s", candidate_url, _short_error(exc))
                    channel_id = None
                if channel_id:
                    break
        if not channel_id and not channel.get("queries"):
            logger.error("Kanal '%s': keine Channel-ID gefunden — übersprungen", name)
            continue

        logger.info("YouTube-Kanal '%s' (%s): suche Videos …", name, channel_id or "Suche")
        try:
            videos = discover_channel_videos(session, channel, max_videos_per_channel, rate_limiter, retries)
        except Exception as exc:  # noqa: BLE001
            logger.error("Kanal '%s': Video-Discovery fehlgeschlagen: %s — übersprungen", name, _short_error(exc))
            continue
        if not videos:
            logger.warning("Kanal '%s': keine Videos gefunden", name)

        for video in videos:
            title = video.get("title") or ""
            channel_label = video.get("channel") or name
            video_subject = canonical_subject(subject) if subject else infer_subject(
                f"{channel_label} {title}", default=default_subject
            )
            sources.append(Source(
                subject=video_subject,
                topic=infer_topic(video_subject, title, default="Allgemein"),
                title=title,
                url=canonical_video_url(video["video_id"]),
                type=TYPE_VIDEO,
                difficulty=difficulty,
                video_id=video["video_id"],
                channel=channel_label,
                languages=tuple(languages),
            ))
        logger.info("YouTube-Kanal '%s': %d Video(s) vorgemerkt", name, len(videos))
    return sources


def load_extra_sources(path: str, defaults: dict[str, str]) -> list[Source]:
    """Lädt zusätzliche Quellen aus einer JSON-Datei.

    Akzeptiert eine Liste, ein einzelnes Quellen-Objekt oder {"sources": [...]}.
    Einträge dürfen reine URL-Strings oder Objekte mit subject/topic/title/
    type/difficulty/url/channel sein.
    """
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict) and "sources" in data:
        items = data["sources"]
    elif isinstance(data, list):
        items = data
    else:
        items = [data]

    sources: list[Source] = []
    for item in items:
        if isinstance(item, str):
            item = {"url": item}
        if not isinstance(item, dict) or not item.get("url"):
            logger.warning("Ungültiger Quellen-Eintrag in %s übersprungen: %r", path, item)
            continue
        url = str(item["url"])
        video_id = extract_video_id(url)
        is_youtube = "youtube.com" in url.lower() or "youtu.be" in url.lower()
        is_video = item.get("type") == TYPE_VIDEO or (video_id is not None and is_youtube)
        sources.append(Source(
            subject=canonical_subject(item.get("subject", defaults.get("subject"))),
            topic=item.get("topic", defaults.get("topic", "Allgemein")),
            title=item.get("title", ""),
            url=url,
            type=item.get("type", TYPE_VIDEO if is_video else TYPE_WEB),
            difficulty=item.get("difficulty", defaults.get("difficulty", DIFFICULTY_MEDIUM)),
            video_id=video_id if is_video else None,
            channel=item.get("channel"),
        ))
    return sources


def dedupe_sources(sources: Iterable[Source]) -> list[Source]:
    seen: set[str] = set()
    result: list[Source] = []
    for source in sources:
        key = source.url.strip().rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(source)
    return result


# ---------------------------------------------------------------------------
# Batch-Verarbeitung
# ---------------------------------------------------------------------------


def chunked(seq: Sequence[Source], size: int) -> Iterable[list[Source]]:
    size = max(1, size)
    for i in range(0, len(seq), size):
        yield list(seq[i : i + size])


def scrape_in_batches(
    sources: Sequence[Source],
    *,
    session: requests.Session,
    rate_limiter: RateLimiter,
    batch_size: int = 5,
    batch_pause: float = 2.0,
    retries: int = 3,
    languages: Sequence[str] = DEFAULT_LANGUAGES,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Batch-Verarbeitung mit Rate-Limiting + Fortschritts-Logging.

    Ein Fehler bei einem Eintrag bricht weder den Batch noch den Lauf ab;
    fehlgeschlagene Einträge werden gesammelt zurückgegeben.
    """
    total = len(sources)
    records: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    ok = failed = 0
    started_at = time.monotonic()
    batches = list(chunked(list(sources), batch_size))
    num_batches = len(batches)
    done = 0

    logger.info(
        "Starte Scraping: %d Quelle(n) in %d Batch(es) à max. %d | Rate-Limit %.2fs/Request | Pause %.1fs zwischen Batches | Retries %d",
        total, num_batches, max(1, batch_size), rate_limiter.min_interval, batch_pause, retries,
    )

    for batch_index, batch in enumerate(batches, start=1):
        logger.info("--- Batch %d/%d (%d Quelle(n)) ---", batch_index, num_batches, len(batch))
        for source in batch:
            label = f"[{source.type}] {source.title or source.url}".strip()
            logger.info("Verarbeite: %s", label)
            try:
                record = scrape_one(source, session, rate_limiter, retries, languages)
                records.append(record)
                ok += 1
                logger.info(
                    "OK: %s | subject=%s topic=%s type=%s difficulty=%s | %d Wörter",
                    record["title"], record["subject"], record["topic"],
                    record["type"], record["difficulty"], record.get("word_count", 0),
                )
            except Exception as exc:  # noqa: BLE001 - pro Eintrag isolieren
                failed += 1
                error = {
                    "subject": source.subject,
                    "topic": source.topic,
                    "title": source.title,
                    "type": source.type,
                    "url": source.url,
                    "difficulty": source.difficulty,
                    "error": _short_error(exc, limit=500),
                    "failed_at": _now_iso(),
                }
                errors.append(error)
                logger.error("FEHLER bei %s: %s", label, _short_error(exc))
            done += 1
            log_progress(done, total, ok, failed, started_at, label)

        if batch_index < num_batches and batch_pause > 0:
            logger.info("Pause %.1fs zwischen Batches …", batch_pause)
            time.sleep(batch_pause)

    elapsed = time.monotonic() - started_at
    logger.info(
        "Fertig: %d/%d ok, %d Fehler in %s.", ok, total, failed, _fmt_seconds(elapsed)
    )
    return records, errors


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Bildungs-Content-Scraper: Web + YouTube-Transkripte mit Metadaten, "
                    "Batch-Verarbeitung, Rate-Limiting, Fortschritts-Logging.",
    )
    parser.add_argument("--output", default="scraped_data.json", help="Ausgabedatei (JSON). Default: scraped_data.json")
    parser.add_argument("--only", choices=["all", TYPE_WEB, TYPE_VIDEO], default="all", help="Nur Web-Quellen oder nur YouTube-Videos scrapen.")
    parser.add_argument("--subject", action="append", choices=list(SUBJECTS), help="Nur dieses Fach scrapen (wiederholbar).")
    parser.add_argument("--no-web", action="store_true", help="Kuratierte Web-Quellen auslassen.")
    parser.add_argument("--no-youtube", action="store_true", help="YouTube-Kanäle auslassen.")
    parser.add_argument("--url", action="append", default=[], help="Zusätzliche Web-URL scrapen (wiederholbar).")
    parser.add_argument("--youtube-video", action="append", default=[], help="Zusätzliche YouTube-Video-URL/ID (wiederholbar).")
    parser.add_argument("--sources-file", help="JSON-Datei mit zusätzlichen Quellen.")
    parser.add_argument("--subject-for-custom", default=None, help="Fach für zusätzliche URLs (Default: erraten bzw. 'Sonstiges').")
    parser.add_argument("--topic-for-custom", default="Allgemein", help="Thema für zusätzliche URLs.")
    parser.add_argument("--difficulty-for-custom", default=DIFFICULTY_MEDIUM, choices=list(DIFFICULTIES), help="Schwierigkeit für zusätzliche URLs.")
    # Batch-Verarbeitung & Rate-Limiting
    parser.add_argument("--batch-size", type=int, default=5, help="Anzahl Quellen pro Batch. Default: 5")
    parser.add_argument("--batch-pause", type=float, default=2.0, help="Pause in Sekunden zwischen Batches. Default: 2.0")
    parser.add_argument("--delay", type=float, default=1.0, help="Rate-Limiting: Mindestabstand in Sekunden zwischen Requests. Default: 1.0")
    parser.add_argument("--retries", type=int, default=3, help="Anzahl Retries pro Request mit Backoff. Default: 3")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP-Timeout in Sekunden. Default: 20")
    parser.add_argument("--max-videos-per-channel", type=int, default=5, help="Max. Videos pro YouTube-Kanal. Default: 5")
    parser.add_argument("--languages", default=",".join(DEFAULT_LANGUAGES), help="Bevorzugte Transkript-Sprachen (kommagetrennt). Default: de,en")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="HTTP User-Agent.")
    # Logging
    parser.add_argument("--log-file", default=None, help="Fortschritts-Log zusätzlich in Datei schreiben.")
    parser.add_argument("--verbose", action="store_true", help="Debug-Logging.")
    parser.add_argument("--list-sources", action="store_true", help="Quellen auflisten, nichts scrapen.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    setup_logging(log_file=args.log_file, verbose=args.verbose)

    languages = tuple(lang.strip() for lang in args.languages.split(",") if lang.strip()) or DEFAULT_LANGUAGES
    session = build_session(user_agent=args.user_agent)
    rate_limiter = RateLimiter(min_interval_seconds=args.delay)

    custom_defaults = {
        "subject": args.subject_for_custom or SUBJECT_UNKNOWN,
        "topic": args.topic_for_custom,
        "difficulty": args.difficulty_for_custom,
    }

    # ---- Quellen zusammenstellen ----
    sources: list[Source] = []

    if not args.no_web and args.only in ("all", TYPE_WEB):
        sources.extend(WEB_SOURCES)

    for url in args.url:
        sources.append(Source(
            subject=canonical_subject(args.subject_for_custom) if args.subject_for_custom else infer_subject(url, default=SUBJECT_UNKNOWN),
            topic=args.topic_for_custom,
            title="",
            url=url,
            type=TYPE_WEB,
            difficulty=args.difficulty_for_custom,
        ))

    for video in args.youtube_video:
        video_id = extract_video_id(video)
        if not video_id:
            logger.error("YouTube-URL ohne Video-ID übersprungen: %s", video)
            continue
        sources.append(Source(
            subject=canonical_subject(args.subject_for_custom) if args.subject_for_custom else SUBJECT_UNKNOWN,
            topic=args.topic_for_custom,
            title="",
            url=canonical_video_url(video_id),
            type=TYPE_VIDEO,
            difficulty=args.difficulty_for_custom,
            video_id=video_id,
            languages=languages,
        ))

    if args.sources_file:
        sources.extend(load_extra_sources(args.sources_file, custom_defaults))

    # YouTube-Kanäle erweitern (Rate-Limiting gilt auch für Discovery-Requests).
    if not args.no_youtube and args.only in ("all", TYPE_VIDEO) and YOUTUBE_CHANNELS:
        logger.info("Erweitere YouTube-Kanäle …")
        sources.extend(expand_youtube_channels(
            session=session,
            channels=YOUTUBE_CHANNELS,
            max_videos_per_channel=args.max_videos_per_channel,
            rate_limiter=rate_limiter,
            retries=args.retries,
            languages=languages,
        ))

    # Filters
    if args.only == TYPE_WEB:
        sources = [s for s in sources if s.type == TYPE_WEB]
    elif args.only == TYPE_VIDEO:
        sources = [s for s in sources if s.type == TYPE_VIDEO]
    if args.subject:
        wanted = {s.lower() for s in args.subject}
        sources = [s for s in sources if s.subject.lower() in wanted]

    sources = dedupe_sources(sources)

    if args.list_sources:
        print(f"{len(sources)} Quelle(n):")
        for source in sources:
            print(f"  [{source.type:5s}] {source.subject:11s} | {source.topic:30s} | {source.title or '(Titel von Seite)'} | {source.url}")
        return 0

    if not sources:
        logger.error("Keine Quellen zum Scrapen.")
        return 1

    # ---- Batch-Verarbeitung ----
    records, errors = scrape_in_batches(
        sources,
        session=session,
        rate_limiter=rate_limiter,
        batch_size=args.batch_size,
        batch_pause=args.batch_pause,
        retries=args.retries,
        languages=languages,
    )

    # ---- Ausgabe ----
    output = {
        "scraper": "scraper.py",
        "generated_at": _now_iso(),
        "count": len(records),
        "failed_count": len(errors),
        "items": records,
        "errors": errors,
    }
    output_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(output_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
    logger.info("Geschrieben: %s (%d Einträge, %d Fehler)", args.output, len(records), len(errors))
    print(json.dumps({"output": args.output, "count": len(records), "failed": len(errors)}, ensure_ascii=False))
    return 0 if records else 1


if __name__ == "__main__":
    raise SystemExit(main())
