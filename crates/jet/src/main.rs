//! Start the browser server with explicit deployment settings.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    // The server starts itself again with this argument to read an attached file in a process of
    // its own. That process must not build a runtime or open a port.
    if args.first().map(String::as_str) == Some(jet::READ_FILE_ARGUMENT) {
        return jet::run_file_reader();
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "jet [--listen 127.0.0.1:8787] [--data-dir jet-data] [--public-origin https://jet.example] [--ui-dir PATH] [--disable-feelings]"
        );
        return ExitCode::SUCCESS;
    }
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("jet: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("jet: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Vec<String>) -> Result<(), jet::ServerError> {
    let mut config = jet::ServerConfig::from_args(args)?;
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    let address = listener.local_addr()?;
    config.listen = address;
    let host = jet::Server::open(config)?;
    println!("Jet listening on http://{address}");
    host.serve(listener).await
}
