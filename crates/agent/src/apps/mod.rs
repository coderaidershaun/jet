//! Register independently running apps without coupling them to a chat or a window.
mod address;
mod descriptor;
mod model;
mod registry;
mod storage;

pub use address::AppAddress;
pub use descriptor::{AppDescriptor, DiscoveryStatus};
pub use model::{
    AddApp, App, AppId, AppOverrides, Embedding, McpOverride, RegistryChange, RegistryCommand,
    RegistryEvent, RegistryResult,
};
pub use registry::Registry;
pub use storage::RegistryError;
