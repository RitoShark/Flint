//! Managed, opt-in stdio LSP. Only Flint's hash-disabled build is installed.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};
use tauri::{ipc::Channel, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

const RELEASES: &str = "https://github.com/RitoShark/Flint/releases/download";
const MAX_MESSAGE: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub struct LspState {
    sessions: Mutex<HashMap<String, LspSession>>,
    installed: tokio::sync::Mutex<Option<PathBuf>>,
}

struct LspSession {
    tx: mpsc::Sender<Value>,
    // Dropping the session interrupts even a blocked stdin write.
    _cancel: oneshot::Sender<()>,
    window: String,
}

impl LspState {
    pub fn stop_all(&self) {
        self.sessions.lock().clear();
    }

    pub fn stop_window(&self, label: &str) {
        self.sessions
            .lock()
            .retain(|_, session| session.window != label);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    #[serde(default)]
    flint_version: String,
    asset: String,
    sha256: String,
    no_hashes: u32,
}

fn valid_manifest(m: &Manifest) -> bool {
    m.no_hashes == 1
        && !m.version.is_empty()
        && m.version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        && m.asset == format!("ritobin-lsp-{}-windows-x86_64.exe", m.version)
        && m.sha256.len() == 64
        && m.sha256.bytes().all(|c| c.is_ascii_hexdigit())
}

async fn verified_binary(dir: &std::path::Path, m: &Manifest) -> Option<PathBuf> {
    if !valid_manifest(m) {
        return None;
    }
    let path = dir.join(&m.asset);
    let bytes = tokio::fs::read(&path).await.ok()?;
    (format!("{:x}", Sha256::digest(&bytes)) == m.sha256.to_lowercase()).then_some(path)
}

/// Local development never needs a published release. This lookup is excluded
/// from release builds; only an explicitly staged, verified server is accepted.
#[cfg(debug_assertions)]
async fn development_binary(flint_version: &str) -> Result<Option<PathBuf>, String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/ritobin-lsp");
    let data = match tokio::fs::read(dir.join("manifest.json")).await {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read development LSP manifest: {error}")),
    };
    let manifest: Manifest = serde_json::from_slice(&data)
        .map_err(|error| format!("Invalid development LSP manifest: {error}"))?;
    if manifest.flint_version != flint_version {
        return Err("Development LSP was staged for another Flint version; run scripts/lsp/stage-dev.mjs again.".into());
    }
    let binary = verified_binary(&dir, &manifest)
        .await
        .ok_or("Development LSP verification failed; run scripts/lsp/stage-dev.mjs again.")?;
    tracing::info!(
        "ritobin LSP: using verified local development server {}",
        binary.display()
    );
    Ok(Some(binary))
}

async fn install(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("The managed ritobin LSP currently supports Windows x64.".into());
    }
    let flint_version = app.package_info().version.to_string();
    #[cfg(debug_assertions)]
    if let Some(binary) = development_binary(&flint_version).await? {
        return Ok(binary);
    }
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("ritobin-lsp");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let cached = async {
        let data = tokio::fs::read(dir.join("manifest.json")).await.ok()?;
        let m: Manifest = serde_json::from_slice(&data).ok()?;
        let path = verified_binary(&dir, &m).await?;
        Some((m, path))
    }
    .await;
    // Reuse this Flint release's verified installation without an update request.
    // A new Flint version fetches its own release asset on first opt-in use.
    if let Some((manifest, path)) = &cached {
        if manifest.flint_version == flint_version {
            return Ok(path.clone());
        }
    }
    let release = format!("{RELEASES}/v{flint_version}");
    let installation = async {
        let client = reqwest::Client::builder()
            .user_agent("Flint-ritobin-lsp")
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| e.to_string())?;
        let m: Manifest = client
            .get(format!("{release}/ritobin-lsp-manifest.json"))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if !valid_manifest(&m) || m.flint_version != flint_version {
            return Err("Invalid hash-disabled LSP manifest".to_string());
        }
        if let Some(path) = verified_binary(&dir, &m).await {
            tokio::fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap())
                .await
                .map_err(|e| e.to_string())?;
            return Ok(path);
        }
        let mut response = client
            .get(format!("{release}/{}", m.asset))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > 128 * 1024 * 1024 {
                return Err("LSP download too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if format!("{:x}", Sha256::digest(&bytes)) != m.sha256.to_lowercase() {
            return Err("LSP download checksum mismatch".into());
        }
        let staging = dir.join("download.tmp");
        tokio::fs::write(&staging, bytes)
            .await
            .map_err(|e| e.to_string())?;
        let binary = dir.join(&m.asset);
        tokio::fs::rename(&staging, &binary)
            .await
            .map_err(|e| e.to_string())?;
        // Cache only after the complete executable has passed verification.
        tokio::fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap())
            .await
            .map_err(|e| e.to_string())?;
        Ok(binary)
    }
    .await;
    match installation {
        Ok(path) => Ok(path),
        Err(error) => {
            tracing::warn!("ritobin LSP release installation unavailable: {error}");
            cached
                .map(|(_, path)| path)
                .ok_or_else(|| format!("Could not install Flint's hash-disabled LSP: {error}"))
        }
    }
}

async fn read_message<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<Value, String> {
    let mut size = None;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        if reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?
            == 0
        {
            return Err("Language server exited".into());
        }
        header_bytes += line.len();
        if header_bytes > 8192 {
            return Err("LSP header too large".into());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("Content-Length") {
                size = value.trim().parse::<usize>().ok();
            }
        }
    }
    let size = size
        .filter(|n| *n <= MAX_MESSAGE)
        .ok_or("Invalid LSP Content-Length")?;
    let mut body = vec![0; size];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ritobin_lsp_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, LspState>,
    session: String,
    messages: Channel<Value>,
) -> Result<(), String> {
    let (tx, mut rx) = mpsc::channel::<Value>(128);
    let (cancel, cancelled) = oneshot::channel::<()>();
    {
        let mut sessions = state.sessions.lock();
        if sessions.contains_key(&session) {
            return Err("LSP session already exists".into());
        }
        sessions.insert(
            session.clone(),
            LspSession {
                tx,
                _cancel: cancel,
                window: window.label().to_owned(),
            },
        );
    }
    let result = async {
        let mut installed = state.installed.lock().await;
        if installed.is_none() { *installed = Some(install(&app).await?); }
        let path = installed.as_ref().unwrap().clone();
        drop(installed);
        // A setting change or tab close can cancel while installation is in flight.
        if !state.sessions.lock().contains_key(&session) { return Err("LSP startup cancelled".into()); }
        let mut command = tokio::process::Command::new(path);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let mut input = child.stdin.take().ok_or("Missing LSP stdin")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("Missing LSP stdout")?);
        let mut stderr = BufReader::new(child.stderr.take().ok_or("Missing LSP stderr")?);
        let handle = app.clone();
        let id = session.clone();
        // Keep the reader future alive while processing outgoing messages: read_exact
        // is not cancellation safe when a server response arrives in multiple chunks.
        tauri::async_runtime::spawn(async move {
            let reader = async {
                loop { messages.send(read_message(&mut output).await?).map_err(|e| e.to_string())?; }
                #[allow(unreachable_code)] Ok::<(), String>(())
            };
            let writer = async {
                while let Some(message) = rx.recv().await {
                    let body = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
                    input.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await.map_err(|e| e.to_string())?;
                    input.write_all(&body).await.map_err(|e| e.to_string())?;
                    input.flush().await.map_err(|e| e.to_string())?;
                }
                Ok::<(), String>(())
            };
            let server_logs = async {
                loop {
                    // Bound each chunk even if the server writes a very long line.
                    let mut line = Vec::new();
                    let n = (&mut stderr).take(16 * 1024).read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        // Closing stderr alone does not terminate a healthy protocol session.
                        return std::future::pending::<Result<(), String>>().await;
                    }
                    messages.send(json!({"method":"flint/stderr", "params": {"message":String::from_utf8_lossy(&line).trim_end()}})).map_err(|e| e.to_string())?;
                }
            };
            let result = tokio::select! { r = reader => r, r = writer => r, r = server_logs => r, _ = cancelled => Ok(()) };
            let _ = child.kill().await;
            let _ = child.wait().await;
            handle.state::<LspState>().sessions.lock().remove(&id);
            let _ = messages.send(json!({"method":"flint/exited", "params": {"message":result.err().unwrap_or_else(|| "Language server stopped".into())}}));
        });
        Ok(())
    }.await;
    if result.is_err() {
        state.sessions.lock().remove(&session);
    }
    result
}

fn allowed_method(method: &str) -> bool {
    matches!(
        method,
        "initialize"
            | "initialized"
            | "shutdown"
            | "exit"
            | "$/cancelRequest"
            | "textDocument/didOpen"
            | "textDocument/didChange"
            | "textDocument/didClose"
            | "textDocument/completion"
            | "completionItem/resolve"
            | "textDocument/hover"
            | "textDocument/formatting"
    )
}

#[tauri::command]
pub async fn ritobin_lsp_send(
    state: State<'_, LspState>,
    session: String,
    message: Value,
) -> Result<(), String> {
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        if !allowed_method(method) {
            return Err(format!("LSP method is disabled: {method}"));
        }
    } else if message.get("id").is_none() {
        return Err("Invalid LSP message".into());
    }
    let tx = state
        .sessions
        .lock()
        .get(&session)
        .map(|session| session.tx.clone())
        .ok_or("LSP session is closed")?;
    tx.send(message).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ritobin_lsp_stop(state: State<'_, LspState>, session: String) {
    state.sessions.lock().remove(&session);
}

/// Reuse Flint's local LMDB-backed BIN dictionary, including its custom overlays.
/// No Mimir discovery, downloads, document edits, or separate server hash cache.
#[tauri::command]
pub async fn ritobin_lsp_lookup_names(hashes: Vec<u32>) -> Result<HashMap<u32, String>, String> {
    if hashes.len() > 100_000 {
        return Err("Too many completion hashes".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let cache = flint_core::hash::get_cached_bin_hashes().read();
        hashes.into_iter().filter_map(|hash| {
            cache.get(u64::from(hash)).map(|name| (hash, name.to_owned()))
        }).collect()
    }).await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_hash_and_file_mutation_methods() {
        for method in [
            "ritobin-lsp/unhash",
            "workspace/executeCommand",
            "ritobin-lsp/deserializeBin",
            "ritobin-lsp/serializeBin",
        ] {
            assert!(!allowed_method(method));
        }
        assert!(allowed_method("textDocument/completion"));
    }
    #[tokio::test]
    async fn parses_utf8_framing() {
        let body = r#"{"result":"Türkçe 🦈"}"#;
        let data = format!("Content-Length: {}\r\n\r\n{body}", body.len());
        let mut reader = BufReader::new(data.as_bytes());
        assert_eq!(
            read_message(&mut reader).await.unwrap()["result"],
            "Türkçe 🦈"
        );
    }
    #[test]
    fn rejects_untrusted_manifests() {
        let mut m = Manifest {
            version: "abc-123".into(),
            flint_version: "2.9.7".into(),
            asset: "ritobin-lsp-abc-123-windows-x86_64.exe".into(),
            sha256: "a".repeat(64),
            no_hashes: 1,
        };
        assert!(valid_manifest(&m));
        m.no_hashes = 0;
        assert!(!valid_manifest(&m));
        m.no_hashes = 1;
        m.asset = "../server.exe".into();
        assert!(!valid_manifest(&m));
    }
}
