//! Start the browser server with explicit deployment settings.

use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "jet [--listen 127.0.0.1:8787] [--data-dir jet-data] [--public-origin https://jet.example] [--ui-dir PATH] [--disable-feelings]"
        );
        return ExitCode::SUCCESS;
    }
    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("jet: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Vec<String>) -> Result<(), jet::ServerError> {
    let config = jet::ServerConfig::from_args(args)?;
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    let address = listener.local_addr()?;
    let host = jet::Server::open(config)?;
    println!("Jet listening on http://{address}");
    host.serve(listener).await
}
