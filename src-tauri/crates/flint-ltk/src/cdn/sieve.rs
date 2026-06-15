use serde::Deserialize;

use crate::error::{Error, Result};

/// Target OS for the sieve `q[platform]` query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Macos,
    Android,
    Ios,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Windows => "windows",
            Platform::Macos => "macos",
            Platform::Android => "android",
            Platform::Ios => "ios",
        }
    }

    pub fn from_str_lenient(s: &str) -> Platform {
        match s.to_ascii_lowercase().as_str() {
            "macos" => Platform::Macos,
            "android" => Platform::Android,
            "ios" => Platform::Ios,
            _ => Platform::Windows,
        }
    }
}

/// All Riot regions the sieve API accepts.
pub const REGIONS: &[&str] = &[
    "BR1", "EUN1", "EUW1", "JP1", "KR", "LA1", "LA2", "ME1", "NA1", "OC1", "PBE1", "PH2", "RU",
    "SG2", "TH2", "TR1", "TW2", "VN2",
];

/// Normalized artifact category derived from the raw `artifact_type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactKind {
    /// `lol-game-client` — the moddable game data.
    GameClient,
    /// `lol-standalone-client-content` — the League Client UI content.
    ClientContent,
    Other,
}

impl ArtifactKind {
    pub fn from_artifact_type(t: &str) -> ArtifactKind {
        match t {
            "lol-game-client" => ArtifactKind::GameClient,
            "lol-standalone-client-content" => ArtifactKind::ClientContent,
            _ => ArtifactKind::Other,
        }
    }

    /// Short tag for the frontend (`"game" | "client" | "other"`).
    pub fn tag(self) -> &'static str {
        match self {
            ArtifactKind::GameClient => "game",
            ArtifactKind::ClientContent => "client",
            ArtifactKind::Other => "other",
        }
    }
}

/// The clean leading `N.N.N…` patch number from a verbose version string.
///
/// The sieve `version` is a blob like
/// `16.12.7869679+branch.releases-16-12.code.public…`; the part before `+` is the
/// dotted-numeric patch. If that head is not clean dotted-numeric it is returned as-is.
pub fn patch_label(version: &str) -> String {
    version.split('+').next().unwrap_or(version).to_string()
}

/// One downloadable manifest discovered from a version-set response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestEntry {
    pub artifact_type: String,
    pub kind: ArtifactKind,
    pub version: String,
    pub patch: String,
    pub url: String,
}

#[derive(Deserialize)]
struct VersionSet {
    #[serde(default)]
    releases: Vec<ReleaseElement>,
}
#[derive(Deserialize)]
struct ReleaseElement {
    release: ReleaseInner,
    download: Download,
}
#[derive(Deserialize)]
struct ReleaseInner {
    labels: Labels,
}
#[derive(Deserialize)]
struct Labels {
    #[serde(rename = "riot:artifact_type_id")]
    artifact_type_id: Option<LabelValues>,
    #[serde(rename = "riot:artifact_version_id")]
    artifact_version_id: Option<LabelValues>,
}
#[derive(Deserialize)]
struct LabelValues {
    #[serde(default)]
    values: Vec<String>,
}
#[derive(Deserialize)]
struct Download {
    url: String,
}

/// Parse a sieve version-set body into manifest entries. Elements missing an artifact
/// type, version, or url are skipped (partial sieve data is non-fatal).
pub fn parse_version_set(body: &str) -> Result<Vec<ManifestEntry>> {
    let set: VersionSet =
        serde_json::from_str(body).map_err(|e| Error::Cdn(format!("invalid sieve json: {e}")))?;
    let entries = set
        .releases
        .into_iter()
        .filter_map(|el| {
            let artifact_type = el
                .release
                .labels
                .artifact_type_id?
                .values
                .into_iter()
                .next()?;
            let version = el
                .release
                .labels
                .artifact_version_id?
                .values
                .into_iter()
                .next()?;
            let kind = ArtifactKind::from_artifact_type(&artifact_type);
            let patch = patch_label(&version);
            Some(ManifestEntry {
                artifact_type,
                kind,
                version,
                patch,
                url: el.download.url,
            })
        })
        .collect();
    Ok(entries)
}

/// Build the sieve version-set URL for a region/platform (LoL product).
pub fn sieve_url(region: &str, platform: Platform) -> String {
    format!(
        "https://sieve.services.riotcdn.net/api/v1/products/lol/version-sets/{}?q[platform]={}",
        region,
        platform.as_str()
    )
}

/// Fetch + parse the available manifests for a region/platform.
pub async fn fetch_manifests(
    client: &reqwest::Client,
    region: &str,
    platform: Platform,
) -> Result<Vec<ManifestEntry>> {
    let url = sieve_url(region, platform);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| Error::Cdn(format!("sieve request: {e}")))?;
    if !resp.status().is_success() {
        return Err(Error::Cdn(format!(
            "sieve request to {url} failed: HTTP {}",
            resp.status()
        )));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| Error::Cdn(format!("sieve body: {e}")))?;
    parse_version_set(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "releases": [
        {"release":{"labels":{
            "riot:artifact_type_id":{"values":["lol-game-client"]},
            "riot:artifact_version_id":{"values":["16.12.7869679+branch.releases-16-12.code.public.content.release.cpuarch.x86.platform.windows"]}}},
         "download":{"url":"https://x.riotcdn.net/a/D1E5F3E1C25EB66D.manifest"}},
        {"release":{"labels":{
            "riot:artifact_type_id":{"values":["lol-standalone-client-content"]},
            "riot:artifact_version_id":{"values":["16.12.7869679+branch.releases-16-12.content.release.cpuarch.any.platform.macos-windows"]}}},
         "download":{"url":"https://x.riotcdn.net/a/96D85960903DA455.manifest"}}
      ]
    }"#;

    #[test]
    fn parses_both_artifact_types_with_kind_and_patch() {
        let entries = parse_version_set(SAMPLE).expect("parse");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].kind, ArtifactKind::GameClient);
        assert_eq!(entries[0].patch, "16.12.7869679");
        assert_eq!(entries[1].kind, ArtifactKind::ClientContent);
    }

    #[test]
    fn builds_sieve_url() {
        assert_eq!(
            sieve_url("EUW1", Platform::Windows),
            "https://sieve.services.riotcdn.net/api/v1/products/lol/version-sets/EUW1?q[platform]=windows"
        );
    }

    #[test]
    fn patch_label_extracts_leading_version() {
        assert_eq!(patch_label("16.12.7869679+branch.foo"), "16.12.7869679");
        assert_eq!(patch_label("15.1.123"), "15.1.123");
        assert_eq!(patch_label("weird"), "weird");
    }
}
