//! Federwerk Office <-> WordCraft / GridCraft / DeckCraft.
//!
//! Warum ein eigener WASM-Wrapper statt des fertigen Web-Builds:
//!
//! - `wordcraft-web` bringt 29,75 MiB mit, weil die komplette egui-Oberflaeche
//!   und der Fontbestand mitkompiliert werden. Ueber das 25-MiB-Limit je Datei
//!   bei Cloudflare Workers Static Assets.
//! - Der Web-Build exportiert nur `initSync`/`default`, also gar keine
//!   Dokument-API. Federwerks Datei-Oberflaeche kann damit nichts steuern.
//!
//! Diese Crate zieht nur die headless Crates (`doc`/`docx`, `model`/`xlsx`,
//! `model`/`pptx`) und macht eine schmale Bruecke: Bytes <-> JSON. Das JSON ist
//! der Vertrag mit Federwerk, damit das WASM nicht gegen ein internes
//! Fremdmodell gebaut wird.
//!
//! Beruehrt wird kein Dateisystem, kein Netz und kein Fenster - die
//! Upstream-Entrypoints arbeiten alle auf Byte-Slices.

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Welche Dateiart erkannt wurde. Fuer den Import, damit Federwerk nicht
/// selbst an der Endung raten muss.
#[wasm_bindgen]
#[derive(Serialize)]
pub struct Sniffed {
    /// "docx", "xlsx", "pptx" oder "" wenn nichts passt.
    pub kind: String,
    pub docx: bool,
    pub xlsx: bool,
    pub pptx: bool,
}

#[wasm_bindgen]
impl Sniffed {
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

fn err(msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

/// Erkennt die Dateiart anhand des ZIP-/OOXML-Inhalts, nicht der Endung.
/// Nutzt die `sniff`-Funktionen der Upstream-Crates.
#[wasm_bindgen(js_name = sniff)]
pub fn sniff(bytes: &[u8]) -> Result<Sniffed, JsValue> {
    // gridcraft::sniff liefert einen Format-Enum; wir fragen die beiden anderen
    // Crates ueber ihre eigene Erkennung und nutzen gridcraft fuer xlsx.
    let is_xlsx = matches!(gridcraft_xlsx::sniff(bytes), gridcraft_xlsx::Format::Xlsx);
    let is_docx = zip_is_ooxml(bytes, "word/document.xml");
    let is_pptx = deckcraft_pptx::sniff(bytes);

    let kind = if is_docx {
        "docx"
    } else if is_pptx {
        "pptx"
    } else if is_xlsx {
        "xlsx"
    } else {
        ""
    };
    Ok(Sniffed {
        kind: kind.to_string(),
        docx: is_docx,
        xlsx: is_xlsx,
        pptx: is_pptx,
    })
}

/// Sucht einen OOXML-Teileintrag im ZIP. Dafuer wird der zentrale
/// Verzeichniseintrag gelesen - die Dateien selbst werden nicht entpackt.
fn zip_is_ooxml(bytes: &[u8], part: &str) -> bool {
    match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(mut zip) => zip.by_name(part).is_ok(),
        Err(_) => false,
    }
}

// -- DOCX -------------------------------------------------------------------

/// DOCX -> JSON (Dokumentmodell von WordCraft).
#[wasm_bindgen(js_name = docxToJson)]
pub fn docx_to_json(bytes: &[u8]) -> Result<String, JsValue> {
    let doc = wordcraft_docx::read(bytes).map_err(err)?;
    serde_json::to_string(&doc).map_err(err)
}

/// JSON -> DOCX. Der Weg laeuft ueber `serde_json::Value`, damit ein von
/// Federwerk geliefertes JSON direkt in das Dokumentmodell gespiegelt wird.
#[wasm_bindgen(js_name = jsonToDocx)]
pub fn json_to_docx(json: &str) -> Result<Vec<u8>, JsValue> {
    let doc: wordcraft_doc::Document = serde_json::from_str(json).map_err(err)?;
    wordcraft_docx::write(&doc).map_err(err)
}

// -- XLSX -------------------------------------------------------------------

/// XLSX -> JSON. Liefert `{ "workbook": ..., "warnings": [...] }`, damit die
/// Warnungen des Readers (unbekannte Teile) nicht verloren gehen.
#[wasm_bindgen(js_name = xlsxToJson)]
pub fn xlsx_to_json(bytes: &[u8]) -> Result<String, JsValue> {
    let (wb, report) = gridcraft_xlsx::read_xlsx(bytes).map_err(err)?;
    serde_json::to_string(&serde_json::json!({
        "workbook": wb,
        "warnings": report.warnings,
    }))
    .map_err(err)
}

/// JSON -> XLSX. Erwartet entweder das volle XlsxToJson-Ergebnis oder ein
/// bloses Workbook-Objekt.
#[wasm_bindgen(js_name = jsonToXlsx)]
pub fn json_to_xlsx(json: &str) -> Result<Vec<u8>, JsValue> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(err)?;
    let wb_value = v.get("workbook").unwrap_or(&v);
    let wb: gridcraft_model::Workbook = serde_json::from_value(wb_value.clone()).map_err(err)?;
    gridcraft_xlsx::write_xlsx(&wb).map_err(err)
}

// -- PPTX -------------------------------------------------------------------

/// PPTX -> JSON (Praesentationsmodell von DeckCraft).
#[wasm_bindgen(js_name = pptxToJson)]
pub fn pptx_to_json(bytes: &[u8]) -> Result<String, JsValue> {
    let p = deckcraft_pptx::import(bytes).map_err(err)?;
    serde_json::to_string(&p).map_err(err)
}

/// JSON -> PPTX.
#[wasm_bindgen(js_name = jsonToPptx)]
pub fn json_to_pptx(json: &str) -> Result<Vec<u8>, JsValue> {
    let p: deckcraft_model::Presentation = serde_json::from_str(json).map_err(err)?;
    deckcraft_pptx::export(&p).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_docx() -> Vec<u8> {
        let doc = wordcraft_doc::Document::default();
        wordcraft_docx::write(&doc).expect("demo-docx schreiben")
    }

    #[test]
    fn docx_roundtrip() {
        let bytes = demo_docx();
        assert!(zip_is_ooxml(&bytes, "word/document.xml"), "erzeugtes DOCX ist ein OOXML-Paket");
        let json = docx_to_json(&bytes).expect("lesen");
        let out = json_to_docx(&json).expect("schreiben");
        assert!(zip_is_ooxml(&out, "word/document.xml"), "zurueckgeschriebenes DOCX ist wieder ein Paket");
    }

    #[test]
    fn sniff_findet_eigenes_docx() {
        let bytes = demo_docx();
        let s = sniff(&bytes).expect("sniff");
        assert!(s.docx, "DOCX wird erkannt");
        assert_eq!(s.kind, "docx");
    }

    #[test]
    fn sniff_schweigt_bei_muell() {
        let s = sniff(b"kein zip, nur text").expect("sniff darf nicht paniken");
        assert_eq!(s.kind, "");
        assert!(!s.docx && !s.xlsx && !s.pptx);
    }

    #[test]
    fn leerer_schnipsel_liefert_fehler_statt_panic() {
        assert!(docx_to_json(b"nonsense").is_err());
        assert!(xlsx_to_json(b"nonsense").is_err());
        assert!(pptx_to_json(b"nonsense").is_err());
    }

    #[test]
    fn kaputtes_json_wird_abgelehnt() {
        assert!(json_to_docx("{kein json").is_err());
        assert!(json_to_xlsx("[]").is_err());
        assert!(json_to_pptx("null").is_err());
    }
}