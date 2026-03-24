use std::env;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        eprintln!("Usage: {} <socket-path> <message>", args[0]);
        std::process::exit(1);
    }

    let socket_path = &args[1];
    let message = &args[2];
    let expected_len = message.len();

    let mut stream = UnixStream::connect(socket_path).expect("Failed to connect to server");

    // Send message
    stream
        .write_all(message.as_bytes())
        .expect("Failed to write message");

    // Read echo response
    let mut response = String::new();
    let mut buffer = [0u8; 4096];

    // 不再死等 EOF (0)，而是等待接收到期望长度的数据后就停止读取
    while response.len() < expected_len {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                response.push_str(&String::from_utf8_lossy(&buffer[..n]));
            }
            Err(e) => {
                eprintln!("Failed to read: {}", e);
                std::process::exit(1);
            }
        }
    }

    // Output the echoed message
    println!("{}", response);
}
