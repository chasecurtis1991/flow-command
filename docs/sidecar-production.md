# Production Sidecar Configuration

How to run Flow Gardens Dashboard (Express + Vite build) as a Tauri sidecar in production.

## Overview

In production, Flow Command should:
1. Bundle the built dashboard static assets (`dist/`)
2. Spawn Express server as a sidecar process
3. Point the shell iframe to `http://localhost:3000` (Express serving static + API)

## Tauri Sidecar Options

### Option 1: `externalBin` (Recommended)

Bundle a Node.js binary + Express server script with the Tauri app.

**`src-tauri/tauri.conf.json` additions:**
```json
{
  "bundle": {
    "externalBin": [
      "binaries/dashboard-server"
    ]
  }
}
```

**Steps:**
1. Package Express server as standalone binary (use [`pkg`](https://github.com/vercel/pkg) or [`nexe`](https://github.com/nexe/nexe))
2. Place binary in `src-tauri/binaries/` (Tauri will bundle it)
3. Spawn sidecar in Rust:

```rust
use tauri::api::process::{Command, CommandEvent};

fn spawn_dashboard_sidecar(app_handle: &tauri::AppHandle) {
    let resource_path = app_handle
        .path_resolver()
        .resolve_resource("binaries/dashboard-server")
        .expect("failed to resolve dashboard-server");

    let (mut rx, _child) = Command::new(resource_path)
        .spawn()
        .expect("failed to spawn dashboard server");

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => println!("Dashboard: {}", line),
                CommandEvent::Stderr(line) => eprintln!("Dashboard Error: {}", line),
                _ => {}
            }
        }
    });
}

// Call in main:
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            spawn_dashboard_sidecar(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Option 2: Shell Spawn (Simpler, requires Node.js on user machine)

Bundle Express scripts + static assets; spawn `node server.js` at runtime.

**Pros**: No binary packaging needed
**Cons**: Requires Node.js installed on user machine (less portable)

**Implementation:**
```rust
use std::process::Command;

fn spawn_dashboard() {
    let dashboard_dir = app_handle
        .path_resolver()
        .resolve_resource("dashboard")
        .expect("failed to resolve dashboard directory");

    Command::new("node")
        .arg("server.js")
        .current_dir(dashboard_dir)
        .env("PORT", "3000")
        .spawn()
        .expect("failed to start dashboard server");
}
```

**Bundle structure:**
```
src-tauri/resources/dashboard/
├── server.js          # Express server (from flow-gardens-dashboard)
├── dist/              # Built Vite assets (npm run build output)
└── node_modules/      # Production deps (express, dotenv, etc.)
```

Add to `tauri.conf.json`:
```json
{
  "bundle": {
    "resources": [
      "dashboard/**/*"
    ]
  }
}
```

## Dashboard Build Preparation

Before bundling, build the dashboard:

```bash
cd flow-gardens-dashboard
npm install --production  # Skip devDependencies
npm run build             # Vite build → dist/
```

Then copy to Flow Command:
```bash
mkdir -p ../flow-command/src-tauri/resources/dashboard
cp -r dist/ server.js package.json ../flow-command/src-tauri/resources/dashboard/
cd ../flow-command/src-tauri/resources/dashboard
npm install --production  # Install only prod deps
```

## Secrets in Production

**Never bundle `.env` files.**

Instead:
1. On first launch, prompt user for secrets (Shopify, OpenRouter, etc.)
2. Store in macOS Keychain via `tauri-plugin-keyring`
3. Read at runtime and inject into sidecar's environment:

```rust
use tauri_plugin_keyring::Keyring;

fn get_secret(service: &str, name: &str) -> Result<String, Box<dyn std::error::Error>> {
    let keyring = Keyring::new(service, name)?;
    Ok(keyring.get_password()?)
}

fn spawn_dashboard_with_secrets(app_handle: &tauri::AppHandle) {
    let shopify_id = get_secret("Flow Command", "SHOPIFY_CLIENT_ID").unwrap_or_default();
    let shopify_secret = get_secret("Flow Command", "SHOPIFY_CLIENT_SECRET").unwrap_or_default();

    Command::new("node")
        .arg("server.js")
        .env("SHOPIFY_CLIENT_ID", shopify_id)
        .env("SHOPIFY_CLIENT_SECRET", shopify_secret)
        .env("PORT", "3000")
        .spawn()
        .expect("failed to start dashboard");
}
```

## Port Configuration

| Service      | Port | Notes                          |
|--------------|------|--------------------------------|
| Dashboard    | 3000 | Express (static + API)         |
| FGINV (Phase 2) | 3001 | Next.js standalone server   |
| Shell UI     | 1420 | Vite dev (dev mode only)       |

In production, shell iframe points to `http://localhost:3000`.

## Testing Sidecar Locally

Before bundling, test the sidecar spawn logic:

```bash
# Build dashboard
cd flow-gardens-dashboard && npm run build

# Run Express with built static assets
node server.js
# Should serve http://localhost:3000 (static + API)

# In another terminal, run Tauri
cd flow-command
npm run tauri dev
# Change iframe URL in App.tsx to localhost:3000 temporarily
```

## Lifecycle Management

**On app start:**
- Spawn Express sidecar process
- Wait for health check (`fetch('http://localhost:3000/api/health')`)
- Once ready, load iframe

**On app quit:**
- Terminate sidecar process gracefully
- Use `Command::kill()` or send SIGTERM

**Rust example:**
```rust
use tauri::AppHandle;
use std::sync::Mutex;
use std::process::Child;

struct AppState {
    dashboard_process: Mutex<Option<Child>>,
}

fn shutdown_dashboard(state: tauri::State<AppState>) {
    if let Some(mut child) = state.dashboard_process.lock().unwrap().take() {
        let _ = child.kill();
    }
}

// Register shutdown handler
#[tauri::command]
fn quit_app(app_handle: AppHandle, state: tauri::State<AppState>) {
    shutdown_dashboard(state);
    app_handle.exit(0);
}
```

## Future: FGINV Sidecar (Phase 2)

Same pattern, but for Next.js standalone server:

1. Build FGINV with `next build` → standalone output
2. Bundle `fginv/.next/standalone/` as sidecar
3. Spawn: `node fginv/.next/standalone/server.js` on port 3001
4. Shell sidebar "Inventory → FGINV" switches iframe to `localhost:3001`

## Recommended Tools

- **`pkg`**: Bundle Node.js + server into single binary ([vercel/pkg](https://github.com/vercel/pkg))
- **`nexe`**: Alternative binary packager ([nexe/nexe](https://github.com/nexe/nexe))
- **`tauri-plugin-keyring`**: Keychain/Credential Manager access ([tauri-apps/tauri-plugin-keyring](https://github.com/tauri-apps/tauri-plugin-keyring))

## References

- [Tauri Sidecar Guide](https://v2.tauri.app/develop/sidecar/)
- [Tauri Bundle Resources](https://v2.tauri.app/reference/config/#bundleresources)
- [Tauri Process API](https://v2.tauri.app/reference/javascript/api/namespacecore/#command)

## Summary

**Phase 1 (this spike)**: Dev mode only, dashboard runs separately.

**Phase 2 (production)**:
1. Package Express server as binary or bundle with Node.js
2. Add sidecar spawn logic in Rust
3. Bundle static assets in Tauri resources
4. Integrate Keychain for runtime secrets
5. Test lifecycle (start/stop) thoroughly

For now, this doc serves as a roadmap. Implementation in Phase 2.
