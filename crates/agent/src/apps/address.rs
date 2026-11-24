//! Apply one address convention to registration, discovery and saved entries, and tell an address
//! on the server itself from a public one.
use super::RegistryError;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

/// Where an owner may register apps. An app on the server itself or its private network reaches
/// services nobody published, so only an admin may register one there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Anywhere,
    PublicOnly,
}

/// Whether the address names the server itself or a private network: a loopback, private,
/// link-local or unspecified address, or the name `localhost`. A bare port means `127.0.0.1`.
pub fn is_server_side(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        Some(Host::Ipv4(ip)) => is_private_v4(ip),
        Some(Host::Ipv6(ip)) => is_private_v6(ip),
        None => true,
    }
}

/// Like [`is_server_side`], and also true when the name resolves to such an address now.
// SMELL: the name is resolved only when the app is saved, so a name that points elsewhere later
// (DNS rebinding) still reaches the server. Checking each connection would close it.
pub(super) fn reaches_server_side(url: &Url) -> bool {
    if is_server_side(url) {
        return true;
    }
    let Some(Host::Domain(_)) = url.host() else {
        return false;
    };
    url.socket_addrs(|| None).is_ok_and(|addresses| {
        addresses.iter().any(|address| match address.ip() {
            IpAddr::V4(ip) => is_private_v4(ip),
            IpAddr::V6(ip) => is_private_v6(ip),
        })
    })
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [first, second, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || first == 0
        // Shared address space, used inside carrier and cloud networks.
        || (first == 100 && (64..128).contains(&second))
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || ip.to_ipv4_mapped().is_some_and(is_private_v4)
}

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
        let lowercase = address.to_ascii_lowercase();
        if !lowercase.starts_with("http://") && !lowercase.starts_with("https://") {
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

    pub(super) fn url(&self) -> &Url {
        &self.0
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_loopback_and_private_addresses_are_server_side_and_public_ones_are_not() {
        let server_side = [
            "8080",
            ":8080",
            "http://127.0.0.1:9/",
            "http://localhost:3000/",
            "http://app.localhost/",
            "http://[::1]:8080/",
            "http://10.0.0.5/",
            "http://192.168.1.5/",
            "http://172.16.0.5/",
            "http://169.254.169.254/",
            "http://0.0.0.0/",
            "http://0x7f.1/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fd00::1]/",
        ];
        for address in server_side {
            let parsed = AppAddress::parse(address).unwrap();
            assert!(is_server_side(&parsed.0), "{address}");
        }
        for address in [
            "https://example.com/",
            "http://8.8.8.8/",
            "http://172.32.0.1/",
            "https://[2001:db8::1]/",
        ] {
            let parsed = AppAddress::parse(address).unwrap();
            assert!(!is_server_side(&parsed.0), "{address}");
        }
    }
}
