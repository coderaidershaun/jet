//! Keep saved app identities stable across edits and restarts.
use agent::apps::{AddApp, AppOverrides, Registry, RegistryCommand};

#[test]
fn registry_lifecycle_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("MEMORY.md"), "keep me").unwrap();
    let mut registry = Registry::open(dir.path()).unwrap();
    let events = registry.subscribe();
    assert!(registry.list().is_empty());
    let added = registry
        .execute(RegistryCommand::Add(AddApp {
            address: "http://127.0.0.1:9/".into(),
            overrides: AppOverrides {
                label: Some("Notebook".into()),
                ..Default::default()
            },
        }))
        .unwrap();
    let id = added.app.unwrap().id;
    assert_eq!(events.recv().unwrap().app_id, id);
    registry
        .execute(RegistryCommand::Edit {
            id: id.clone(),
            address: None,
            overrides: Some(AppOverrides {
                label: Some("Research".into()),
                ..Default::default()
            }),
        })
        .unwrap();
    registry
        .execute(RegistryCommand::Disable { id: id.clone() })
        .unwrap();
    drop(registry);
    let mut restored = Registry::open(dir.path()).unwrap();
    let app = restored.get(&id).unwrap();
    assert_eq!(app.label, "Research");
    assert!(!app.enabled);
    assert_eq!(app.id, id);
    let failed_events = restored.subscribe();
    let saved_path = dir.path().join("apps.json");
    let backup_path = dir.path().join("apps.backup.json");
    std::fs::rename(&saved_path, &backup_path).unwrap();
    std::fs::create_dir(&saved_path).unwrap();
    assert!(
        restored
            .execute(RegistryCommand::Enable { id: id.clone() })
            .is_err()
    );
    assert!(!restored.get(&id).unwrap().enabled);
    assert!(failed_events.try_recv().is_err());
    std::fs::remove_dir(&saved_path).unwrap();
    std::fs::rename(&backup_path, &saved_path).unwrap();
    restored
        .execute(RegistryCommand::Enable { id: id.clone() })
        .unwrap();
    restored
        .execute(RegistryCommand::Remove { id: id.clone() })
        .unwrap();
    assert!(Registry::open(dir.path()).unwrap().list().is_empty());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("MEMORY.md")).unwrap(),
        "keep me"
    );
}

#[test]
fn normalized_addresses_deduplicate_and_invalid_inputs_do_not_mutate() {
    use agent::apps::RegistryError;
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path()).unwrap();
    let add = |address: &str| {
        RegistryCommand::Add(AddApp {
            address: address.into(),
            overrides: AppOverrides::default(),
        })
    };
    let id = registry.execute(add(":9")).unwrap().app.unwrap().id;
    for address in ["9", "http://127.0.0.1:9", "http://127.0.0.1:9/"] {
        assert!(
            matches!(registry.execute(add(address)), Err(RegistryError::DuplicateAddress(existing)) if existing == id)
        );
    }
    for address in [
        "",
        "0",
        "65536",
        "file:///tmp/app",
        "javascript:alert(1)",
        "http:example.com",
        "http://user:pass@localhost/",
        "https://example.com/?x=1",
        "https://example.com/#fragment",
        "http://localhost:0",
    ] {
        assert!(
            matches!(
                registry.execute(add(address)),
                Err(RegistryError::InvalidAddress(_))
            ),
            "{address}"
        );
    }
    let invalid_override = registry.execute(RegistryCommand::Edit {
        id: id.clone(),
        address: None,
        overrides: Some(AppOverrides {
            ui: Some(r"\\example.com/ui".into()),
            ..Default::default()
        }),
    });
    assert!(matches!(
        invalid_override,
        Err(RegistryError::InvalidAddress(_))
    ));
    assert_eq!(registry.list().len(), 1);
    assert_eq!(Registry::open(dir.path()).unwrap().list().len(), 1);
}

#[test]
fn discovery_refresh_preserves_overrides_and_reports_failures() {
    use agent::apps::{DiscoveryStatus, Embedding, McpOverride};
    use serde_json::json;
    let descriptor = |name| {
        json!({"version":1,"name":name,"ui":"ui/","mcp":"mcp","embedding":"relative-paths"})
            .to_string()
    };
    let (address, worker) = super::descriptor::server(vec![
        (404, "missing".into()),
        (200, descriptor("Discovered")),
        (200, descriptor("Changed")),
        (200, json!({"version":99}).to_string()),
        (
            200,
            json!({"version":1,"name":"UI only","ui":"./","embedding":"relative-paths"})
                .to_string(),
        ),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path()).unwrap();
    let added = registry
        .execute(RegistryCommand::Add(AddApp {
            address: address.clone(),
            overrides: AppOverrides {
                label: Some("Mine".into()),
                ui: Some("manual/".into()),
                ..Default::default()
            },
        }))
        .unwrap();
    assert_eq!(added.discovery, Some(DiscoveryStatus::Missing));
    let id = added.app.unwrap().id;
    let refreshed = registry
        .execute(RegistryCommand::Refresh { id: id.clone() })
        .unwrap();
    assert_eq!(refreshed.discovery, Some(DiscoveryStatus::Ready));
    let app = refreshed.app.unwrap();
    assert_eq!(app.label, "Mine");
    assert_eq!(app.ui_url.as_str(), format!("{address}manual/"));
    assert_eq!(app.mcp_url.unwrap().as_str(), format!("{address}mcp"));
    assert_eq!(app.embedding, Embedding::RelativePaths);
    let edited = registry
        .execute(RegistryCommand::Edit {
            id: id.clone(),
            address: None,
            overrides: Some(AppOverrides {
                label: Some("Renamed".into()),
                mcp: McpOverride::Disabled,
                ..Default::default()
            }),
        })
        .unwrap();
    assert!(edited.app.unwrap().mcp_url.is_none());
    let incompatible = registry
        .execute(RegistryCommand::Refresh { id: id.clone() })
        .unwrap();
    assert!(matches!(
        incompatible.discovery,
        Some(DiscoveryStatus::Incompatible { .. })
    ));
    assert_eq!(incompatible.app.unwrap().label, "Renamed");
    let ui = registry
        .execute(RegistryCommand::Refresh { id: id.clone() })
        .unwrap()
        .app
        .unwrap();
    assert!(ui.mcp_url.is_none());
    worker.join().unwrap();
    let unavailable = registry
        .execute(RegistryCommand::Refresh { id: id.clone() })
        .unwrap();
    assert!(matches!(
        unavailable.discovery,
        Some(DiscoveryStatus::Unavailable { .. })
    ));
    assert_eq!(unavailable.app.unwrap().id, id);
    registry
        .execute(RegistryCommand::Edit {
            id: id.clone(),
            address: None,
            overrides: Some(AppOverrides {
                label: Some("Manual".into()),
                ui: Some("manual/".into()),
                mcp: McpOverride::Url("manual-mcp".into()),
                embedding: Some(Embedding::Direct),
            }),
        })
        .unwrap();
    let cleared = registry
        .execute(RegistryCommand::Edit {
            id: id.clone(),
            address: None,
            overrides: Some(AppOverrides::default()),
        })
        .unwrap()
        .app
        .unwrap();
    assert_eq!(cleared.label, address);
    assert_eq!(cleared.ui_url.as_str(), address);
    assert!(cleared.mcp_url.is_none());
    assert_eq!(cleared.embedding, Embedding::External);
    let saved = std::fs::read_to_string(dir.path().join("apps.json")).unwrap();
    assert!(!saved.contains("Unavailable"));
    assert_eq!(
        Registry::open(dir.path()).unwrap().discovery_status(&id),
        DiscoveryStatus::NotChecked
    );
}

#[test]
fn legacy_process_configuration_is_rejected_without_erasing_source() {
    use agent::apps::RegistryError;
    let fresh = tempfile::tempdir().unwrap();
    std::fs::write(fresh.path().join("settings.json"), r#"{"mcp":{"quanty":{"enabled":false,"command":"","cwd":null},"polysim":{"enabled":false,"command":"","cwd":null}}}"#).unwrap();
    assert!(Registry::open(fresh.path()).unwrap().list().is_empty());
    for (filename, content) in [
        (
            "apps.json",
            r#"{"version":1,"apps":[{"command":"old-mcp"}]}"#,
        ),
        (
            "settings.json",
            r#"{"persona":{"name":"Ada"},"mcp":{"old":{"command":"old-mcp","enabled":false}}}"#,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(filename);
        std::fs::write(&path, content).unwrap();
        let error = Registry::open(dir.path()).err().unwrap();
        assert!(matches!(error, RegistryError::LegacyCommands { .. }));
        assert!(error.to_string().contains("register running apps"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), content);
    }
}
