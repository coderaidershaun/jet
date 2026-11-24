//! Keep saved app identities stable across edits and restarts, and each app with its owner.
use agent::apps::{
    AddApp, AppOverrides, AppOwner, AppsInMemory, Reach, Registry, RegistryCommand, RegistryError,
};

const OWNER: AppOwner = AppOwner(1);
const OTHER: AppOwner = AppOwner(2);

#[test]
fn registry_lifecycle_survives_restart_and_stays_with_its_owner() {
    let storage = AppsInMemory::default();
    let mut registry = Registry::open(Box::new(storage.clone())).unwrap();
    assert!(registry.list(OWNER).is_empty());
    let added = registry
        .execute(
            OWNER,
            Reach::Anywhere,
            RegistryCommand::Add(AddApp {
                address: "http://127.0.0.1:9/".into(),
                overrides: AppOverrides {
                    label: Some("Notebook".into()),
                    ..Default::default()
                },
            }),
        )
        .unwrap();
    let id = added.app.unwrap().id;
    assert_eq!(added.change.unwrap().app_id, id);
    registry
        .execute(
            OWNER,
            Reach::Anywhere,
            RegistryCommand::Edit {
                id: id.clone(),
                address: None,
                overrides: Some(AppOverrides {
                    label: Some("Research".into()),
                    ..Default::default()
                }),
            },
        )
        .unwrap();
    registry
        .execute(
            OWNER,
            Reach::Anywhere,
            RegistryCommand::Disable { id: id.clone() },
        )
        .unwrap();
    drop(registry);
    let mut restored = Registry::open(Box::new(storage.clone())).unwrap();
    let app = restored.get(&id).unwrap();
    assert_eq!(app.label, "Research");
    assert!(!app.enabled);
    assert_eq!(app.id, id);

    // Another owner neither lists nor changes the app, and may add the same address as its own.
    assert!(restored.list(OTHER).is_empty());
    for command in [
        RegistryCommand::Enable { id: id.clone() },
        RegistryCommand::Remove { id: id.clone() },
    ] {
        assert!(matches!(
            restored.execute(OTHER, Reach::Anywhere, command),
            Err(RegistryError::NotFound(_))
        ));
    }
    let theirs = restored
        .execute(
            OTHER,
            Reach::Anywhere,
            RegistryCommand::Add(AddApp {
                address: "http://127.0.0.1:9/".into(),
                overrides: AppOverrides::default(),
            }),
        )
        .unwrap();
    assert_ne!(theirs.app.unwrap().id, id);
    assert_eq!(restored.list(OWNER).len(), 1);

    restored
        .execute(
            OWNER,
            Reach::Anywhere,
            RegistryCommand::Enable { id: id.clone() },
        )
        .unwrap();
    restored
        .execute(
            OWNER,
            Reach::Anywhere,
            RegistryCommand::Remove { id: id.clone() },
        )
        .unwrap();
    let reopened = Registry::open(Box::new(storage)).unwrap();
    assert!(reopened.list(OWNER).is_empty());
    assert_eq!(reopened.list(OTHER).len(), 1);

    // What an app announces never overrides what the user set, and a failed refresh keeps the app.
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
    ]);
    let storage = AppsInMemory::default();
    let mut registry = Registry::open(Box::new(storage.clone())).unwrap();
    let added = registry
        .execute(
            OWNER,
            Reach::Anywhere,
            RegistryCommand::Add(AddApp {
                address: address.clone(),
                overrides: AppOverrides {
                    label: Some("Mine".into()),
                    ui: Some("manual/".into()),
                    ..Default::default()
                },
            }),
        )
        .unwrap();
    assert_eq!(added.discovery, Some(DiscoveryStatus::Missing));
    let id = added.app.unwrap().id;
    let refresh = |registry: &mut Registry| {
        registry
            .execute(
                OWNER,
                Reach::Anywhere,
                RegistryCommand::Refresh { id: id.clone() },
            )
            .unwrap()
    };
    let refreshed = refresh(&mut registry);
    assert_eq!(refreshed.discovery, Some(DiscoveryStatus::Ready));
    let app = refreshed.app.unwrap();
    assert_eq!(app.label, "Mine");
    assert_eq!(app.ui_url.as_str(), format!("{address}manual/"));
    assert_eq!(app.mcp_url.unwrap().as_str(), format!("{address}mcp"));
    assert_eq!(app.embedding, Embedding::RelativePaths);
    let edited = registry
        .execute(
            OWNER,
            Reach::Anywhere,
            RegistryCommand::Edit {
                id: id.clone(),
                address: None,
                overrides: Some(AppOverrides {
                    label: Some("Renamed".into()),
                    mcp: McpOverride::Disabled,
                    ..Default::default()
                }),
            },
        )
        .unwrap();
    assert!(edited.app.unwrap().mcp_url.is_none());
    let incompatible = refresh(&mut registry);
    assert!(matches!(
        incompatible.discovery,
        Some(DiscoveryStatus::Incompatible { .. })
    ));
    assert_eq!(incompatible.app.unwrap().label, "Renamed");
    worker.join().unwrap();
    let unavailable = refresh(&mut registry);
    assert!(matches!(
        unavailable.discovery,
        Some(DiscoveryStatus::Unavailable { .. })
    ));
    assert_eq!(unavailable.app.unwrap().id, id);
    assert_eq!(
        Registry::open(Box::new(storage))
            .unwrap()
            .discovery_status(&id),
        DiscoveryStatus::NotChecked
    );
}

#[test]
fn normalized_addresses_deduplicate_and_invalid_inputs_do_not_mutate() {
    let storage = AppsInMemory::default();
    let mut registry = Registry::open(Box::new(storage.clone())).unwrap();
    let add = |address: &str| {
        RegistryCommand::Add(AddApp {
            address: address.into(),
            overrides: AppOverrides::default(),
        })
    };
    let id = registry
        .execute(OWNER, Reach::Anywhere, add(":9"))
        .unwrap()
        .app
        .unwrap()
        .id;
    for address in ["9", "http://127.0.0.1:9", "http://127.0.0.1:9/"] {
        assert!(
            matches!(registry.execute(OWNER, Reach::Anywhere, add(address)), Err(RegistryError::DuplicateAddress(existing)) if existing == id)
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
                registry.execute(OWNER, Reach::Anywhere, add(address)),
                Err(RegistryError::InvalidAddress(_))
            ),
            "{address}"
        );
    }
    let invalid_override = registry.execute(
        OWNER,
        Reach::Anywhere,
        RegistryCommand::Edit {
            id: id.clone(),
            address: None,
            overrides: Some(AppOverrides {
                ui: Some(r"\\example.com/ui".into()),
                ..Default::default()
            }),
        },
    );
    assert!(matches!(
        invalid_override,
        Err(RegistryError::InvalidAddress(_))
    ));
    assert_eq!(registry.list(OWNER).len(), 1);
    assert_eq!(
        Registry::open(Box::new(storage)).unwrap().list(OWNER).len(),
        1
    );
}
