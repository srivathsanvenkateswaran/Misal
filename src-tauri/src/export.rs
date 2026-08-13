//! Writing an export to a file the user chose.
//!
//! The only place Misal writes outside its own data directory, and it writes exactly once per
//! explicit user action, to exactly the path a native dialog returned. There is deliberately no
//! command that takes a caller-supplied path: the frontend proposes a *name*, the user chooses the
//! location, and the process never writes anywhere it was told to by the webview.
//!
//! That matters more here than for a general file save. An export contains a complete picture of
//! someone's holdings, so a command accepting an arbitrary destination would be a one-call
//! exfiltration primitive for anything that could reach the IPC bridge.

use crate::error::{MisalError, Result};
use tauri_plugin_dialog::DialogExt;

/// Extensions the save dialog offers, chosen from the suggested file name.
fn filter_for(suggested: &str) -> (&'static str, &'static [&'static str]) {
    if suggested.to_ascii_lowercase().ends_with(".json") {
        ("JSON", &["json"])
    } else {
        ("CSV", &["csv"])
    }
}

/// Strip any directory component from a proposed file name.
///
/// The frontend supplies a name, not a path. Passing `../../.ssh/authorized_keys` through to the
/// dialog as a default would at best confuse the user and at worst pre-fill a destination they did
/// not intend, so only the final component is ever used.
fn safe_file_name(suggested: &str) -> String {
    let trimmed = suggested.trim();
    let base = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim_matches('.');
    if base.is_empty() {
        "misal-export.csv".to_string()
    } else {
        base.to_string()
    }
}

/// Show the native save dialog and write the file.
///
/// Returns the chosen path, or `None` when the user dismissed the dialog — which is an ordinary
/// outcome and must not be reported to them as a failure.
#[tauri::command]
pub async fn save_export_file(
    app: tauri::AppHandle,
    suggested_name: String,
    contents: String,
) -> Result<Option<String>> {
    let name = safe_file_name(&suggested_name);
    let (label, extensions) = filter_for(&name);

    // Async so Tauri runs the blocking dialog off the main thread; called from there it deadlocks
    // the event loop, the same reason `pick_statement_file` is async.
    let chosen = app
        .dialog()
        .file()
        .add_filter(label, extensions)
        .set_title("Save export")
        .set_file_name(&name)
        .blocking_save_file();

    let Some(target) = chosen else {
        return Ok(None);
    };

    let path = target
        .into_path()
        .map_err(|error| MisalError::Other(error.to_string()))?;

    std::fs::write(&path, contents.as_bytes())?;

    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_final_component_of_a_proposed_name() {
        assert_eq!(safe_file_name("misal-holdings.csv"), "misal-holdings.csv");
        assert_eq!(safe_file_name("  spaced.json  "), "spaced.json");
    }

    #[test]
    fn refuses_to_carry_a_path_through_from_the_frontend() {
        // The frontend proposes a name. Anything resembling a path is reduced to its last
        // component, so a traversal cannot pre-fill a destination the user did not intend.
        assert_eq!(safe_file_name("../../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("/Users/someone/.ssh/id_rsa"), "id_rsa");
        assert_eq!(safe_file_name(r"..\..\Windows\System32\config"), "config");
    }

    #[test]
    fn falls_back_rather_than_proposing_an_empty_name() {
        assert_eq!(safe_file_name(""), "misal-export.csv");
        assert_eq!(safe_file_name("   "), "misal-export.csv");
        assert_eq!(safe_file_name("/"), "misal-export.csv");
        assert_eq!(safe_file_name("..."), "misal-export.csv");
    }

    #[test]
    fn offers_the_filter_matching_the_proposed_extension() {
        assert_eq!(filter_for("holdings.json").0, "JSON");
        assert_eq!(filter_for("holdings.csv").0, "CSV");
        assert_eq!(filter_for("HOLDINGS.JSON").0, "JSON");
        // Anything else defaults to CSV rather than offering no filter at all.
        assert_eq!(filter_for("holdings").0, "CSV");
    }
}
