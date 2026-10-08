//! Federwerk Craft <-> PhotoCraft / VectorCraft / DesignCraft.
//!
//! Zweite WASM, bewusst getrennt von `federwerk-office-wasm`: die Office-Engine
//! (DOCX/XLSX/PPTX) wird beim Oeffnen eines Textdokuments gebraucht, diese hier
//! beim Importieren eines Bildes oder Vektorbilds. Zwei Module statt einem
//! grossen, damit jede Datei klein bleibt und nur geladen wird, wenn sie
//! wirklich gebraucht wird.
//!
//! Verzeichnis der Bruecken:
//!   PSD   PhotoCraft    (Photoshop)   photocraft-psd
//!   SVG   VectorCraft   (Illustrator) vectorcraft-svg
//!   IDML  DesignCraft   (InDesign)    designcraft-idml
//!
//! Nicht enthalten: die Codec-Suiten (filmcraft = Premiere, lightcraft =
//! Lightroom, effectcraft = After Effects). Das sind Hunderte von
//! Video-/Audio-Decodern; die wuerden das WASM um ein Vielfaches aufblaehen
//! und sind fuer Federwerks Zweck (Notizbuch) nicht gebraucht.
//!
//! Alle Entrypoints arbeiten auf Byte-Slices bzw. Strings, also ohne Dateisystem
//! und ohne Netz.

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Fehler als String statt JsValue: `JsValue::from_str` paniked ausserhalb von
/// wasm, wodurch native Tests im Fehlerpfad abstuerzten.
fn err(msg: impl std::fmt::Display) -> String {
    msg.to_string()
}

/// Welche Dateiart erkannt wurde.
#[derive(Serialize)]
struct Sniffed {
    /// "psd", "svg", "idml" oder "" wenn nichts passt.
    kind: String,
    psd: bool,
    svg: bool,
    idml: bool,
}

/// Erkennt die Dateiart. PSD wird am 8BPS-Signatur erkannt, SVG an
/// `<?xml`/`<svg`, IDML ueber die `mimetype`-Datei im ZIP.
#[wasm_bindgen(js_name = sniff)]
pub fn sniff(bytes: &[u8]) -> Result<String, String> {
    let is_psd = is_psd(bytes);
    let is_idml = designcraft_idml::is_idml(bytes);
    let is_svg = looks_like_svg(bytes);

    let kind = if is_psd {
        "psd"
    } else if is_idml {
        "idml"
    } else if is_svg {
        "svg"
    } else {
        ""
    };
    serde_json::to_string(&Sniffed {
        kind: kind.to_string(),
        psd: is_psd,
        svg: is_svg,
        idml: is_idml,
    })
    .map_err(err)
}

/// 8BPS = "Photoshop". Steht an Offset 0, danach die Versionsnummer.
fn is_psd(bytes: &[u8]) -> bool {
    bytes.len() > 4 && &bytes[0..4] == b"8BPS"
}

/// SVG ist XML: fuehrende BOM-/Weissraumzeilen ueberspringen, dann auf `<`
/// und die Wurzelschachtel pruefen.
fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    let text = String::from_utf8_lossy(head);
    let low = text.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
    low.starts_with("<?xml") || low.starts_with("<svg") || (low.starts_with('<') && low.contains("<svg"))
}

// -- PSD (Photoshop) --------------------------------------------------------

/// Was aus einer PSD an Federwerk gemeldet wird. Nicht das ganze Modell: die
/// Layer-Pixel sind Rauschedaten, die wuerden ein JSON-Megabyte ergeben.
/// Federwerk braucht Ebenen, Groesse und Ebenennamen - und die gerenderten
/// Pixel holt es sich ueber `psdCompose`, wenn es welche braucht.
#[derive(Serialize)]
struct PsdSummary {
    width: u32,
    height: u32,
    channels: u16,
    depth: u16,
    is_psb: bool,
    layers: Vec<PsdLayerSummary>,
    warnungen: Vec<String>,
}

#[derive(Serialize)]
struct PsdLayerSummary {
    name: String,
    kind: String,
    visible: bool,
    opacity: u8,
    width: u32,
    height: u32,
}

/// PSD lesen und als kompaktes JSON zusammenfassen.
#[wasm_bindgen(js_name = psdToJson)]
pub fn psd_to_json(bytes: &[u8]) -> Result<String, String> {
    let file = photocraft_psd::PsdFile::from_bytes(bytes).map_err(err)?;

    let layers = file
        .layers
        .iter()
        .map(|l| PsdLayerSummary {
            name: l.name.clone(),
            kind: format!("{:?}", l.kind),
            visible: l.visible,
            opacity: l.opacity,
            width: l.rect.right.saturating_sub(l.rect.left),
            height: l.rect.bottom.saturating_sub(l.rect.top),
        })
        .collect();

    let summary = PsdSummary {
        width: file.header.width,
        height: file.header.height,
        channels: file.header.channels,
        depth: file.header.depth,
        is_psb: file.header.version.is_psb(),
        layers,
        warnungen: Vec::new(),
    };
    serde_json::to_string(&summary).map_err(err)
}

// -- SVG (Illustrator) -------------------------------------------------------

/// SVG -> JSON (Dokumentmodell von VectorCraft).
#[wasm_bindgen(js_name = svgToJson)]
pub fn svg_to_json(bytes: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(bytes);
    let doc = vectorcraft_svg::import(&text).map_err(err)?;
    serde_json::to_string(&doc).map_err(err)
}

/// JSON -> SVG. Liefert eine Zeichenkette, weil SVG textbasiert ist.
#[wasm_bindgen(js_name = jsonToSvg)]
pub fn json_to_svg(json: &str) -> Result<String, String> {
    let doc: vectorcraft_doc::Document = serde_json::from_str(json).map_err(err)?;
    let opts = vectorcraft_svg::ExportOptions::default();
    Ok(vectorcraft_svg::export(&doc, &opts))
}

// -- IDML (InDesign) --------------------------------------------------------

/// IDML -> JSON (Dokumentmodell von DesignCraft).
#[wasm_bindgen(js_name = idmlToJson)]
pub fn idml_to_json(bytes: &[u8]) -> Result<String, String> {
    let doc = designcraft_idml::import_idml(bytes).map_err(err)?;
    serde_json::to_string(&doc).map_err(err)
}

/// JSON -> IDML.
#[wasm_bindgen(js_name = jsonToIdml)]
pub fn json_to_idml(json: &str) -> Result<Vec<u8>, String> {
    let doc: designcraft_doc::Document = serde_json::from_str(json).map_err(err)?;
    Ok(designcraft_idml::export_idml(&doc))
}

// -- Import-Hilfe -----------------------------------------------------------

/// Import mit Art-Erkennung, passend zu FederwerkOfficeEngine.import().
#[wasm_bindgen(js_name = importAny)]
pub fn import_any(bytes: &[u8]) -> Result<String, String> {
    let s: serde_json::Value = serde_json::from_str(&sniff(bytes)?).map_err(err)?;
    let kind = s.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    let (kind, json) = match kind {
        "psd" => ("psd", psd_to_json(bytes)?),
        "svg" => ("svg", svg_to_json(bytes)?),
        "idml" => ("idml", idml_to_json(bytes)?),
        _ => return Err("Keine unterstuetzte Grafikdatei erkannt.".to_string()),
    };
    serde_json::to_string(&serde_json::json!({ "kind": kind, "json": json }))
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erkennt_psd_signatur() {
        let mut p = b"8BPS\x00\x01".to_vec();
        p.extend_from_slice(&[0u8; 64]);
        assert!(is_psd(&p));
        assert!(!is_psd(b"nope"));
    }

    #[test]
    fn erkennt_svg_weniger_als_xml() {
        assert!(looks_like_svg(b"<svg xmlns=\"...\"></svg>"));
        assert!(looks_like_svg(b"<?xml version=\"1.0\"?><svg/>"));
        assert!(!looks_like_svg(b"just text"));
    }

    #[test]
    fn sniff_meldet_nichts_bei_muell() {
        let s: serde_json::Value = serde_json::from_str(&sniff(b"nothing here").unwrap()).unwrap();
        assert_eq!(s["kind"], "");
        assert_eq!(s["psd"], serde_json::json!(false));
    }

    #[test]
    fn sniff_meldet_svg() {
        let s: serde_json::Value =
            serde_json::from_str(&sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap()).unwrap();
        assert_eq!(s["kind"], "svg");
        assert_eq!(s["svg"], serde_json::json!(true));
    }

    #[test]
    fn kaputte_dateien_liefern_fehler_statt_panic() {
        assert!(psd_to_json(b"8BPS aber abgeschnitten").is_err());
        assert!(svg_to_json(b"<svg kaputt").is_err());
        assert!(idml_to_json(b"PK kaputt").is_err());
        assert!(import_any(b"nichts").is_err());
    }

    #[test]
    fn kaputtes_json_wird_abgelehnt() {
        assert!(json_to_svg("{kein json").is_err());
        assert!(json_to_idml("[]").is_err());
    }

    #[test]
    fn svg_geht_rund() {
        // Minimaldokument: reicht fuer den Weg ueber das Modell.
        let doc: vectorcraft_doc::Document =
            serde_json::from_str("{\"version\":1}").unwrap_or_default();
        let svg = json_to_svg(&serde_json::to_string(&doc).unwrap()).unwrap();
        assert!(looks_like_svg(svg.as_bytes()) || svg.contains("<svg"));
    }
}