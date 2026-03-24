use std::env;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: {} <socket-path>", args[0]);
        std::process::exit(1);
    }

    let socket_path = &args[1];

    // Remove existing socket file
    if Path::new(socket_path).exists() {
        let _ = std::fs::remove_file(socket_path);
    }

    let listener = UnixListener::bind(socket_path).expect("Failed to bind socket");

    eprintln!("Echo server listening on: {}", socket_path);

    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                eprintln!("Client connected");

                let mut buffer = [0u8; 4096];
                loop {
                    match stream.read(&mut buffer) {
                        Ok(0) => {
                            eprintln!("Client disconnected");
                            break;
                        }
                        Ok(n) => {
                            // Echo back the received data
                            if let Err(e) = stream.write_all(&buffer[..n]) {
                                eprintln!("Failed to write: {}", e);
                                break;
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to read: {}", e);
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("Connection failed: {}", e);
            }
        }
    }
}
