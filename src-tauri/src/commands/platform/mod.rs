//! Platform / host integration: external launchers (Jade / Quartz / LTK
//! Manager / Celestial), Windows file associations, disk-backed settings,
//! and the self-updater.

pub mod external_apps;
pub mod file_assoc;
pub mod ltk_manager;
pub mod settings;
pub mod taskbar;
pub mod updater;
