//! Apply one address convention to registration, discovery and saved entries.
use super::RegistryError;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AppAddress(Url);

impl AppAddress {
    pub fn parse(input: &str) -> Result<Self, RegistryError> {
        let input = input.trim();
        let port = input.strip_prefix(':').unwrap_or(input);
        let expanded;
        let address = if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) {
            let number = port
                .parse::<u16>()
                .ok()
                .filter(|number| *number != 0)
                .ok_or_else(|| RegistryError::InvalidAddress(input.into()))?;
            expanded = format!("http://127.0.0.1:{number}/");
            &expanded
        } else {
            input
        };
        if !address.to_ascii_lowercase().starts_with("http://")
            && !address.to_ascii_lowercase().starts_with("https://")
        {
            return Err(RegistryError::InvalidAddress(input.into()));
        }
        let mut url = valid_url(address)?;
        if url.query().is_some() || url.fragment().is_some() {
            return Err(RegistryError::InvalidAddress(input.into()));
        }
        if !url.path().ends_with('/') {
            url.set_path(&format!("{}/", url.path()));
        }
        Ok(Self(url))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub fn resolve(&self, reference: &str) -> Result<Url, RegistryError> {
        if reference.trim() != reference
            || reference.is_empty()
            || reference.chars().any(char::is_control)
            || reference.contains('\\')
        {
            return Err(RegistryError::InvalidAddress(reference.into()));
        }
        let resolved = self
            .0
            .join(reference)
            .map_err(|_| RegistryError::InvalidAddress(reference.into()))?;
        valid_url(resolved.as_str())
    }
}

fn valid_url(input: &str) -> Result<Url, RegistryError> {
    let url = Url::parse(input).map_err(|_| RegistryError::InvalidAddress(input.into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || input.chars().any(char::is_control)
        || input.contains('\\')
        || url.port() == Some(0)
    {
        return Err(RegistryError::InvalidAddress(input.into()));
    }
    Ok(url)
}
impl TryFrom<String> for AppAddress {
    type Error = RegistryError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}
impl From<AppAddress> for String {
    fn from(value: AppAddress) -> Self {
        value.0.into()
    }
}
