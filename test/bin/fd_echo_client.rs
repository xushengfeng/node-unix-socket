use nix::sys::socket::{ControlMessage, ControlMessageOwned, MsgFlags, recvmsg, sendmsg};
use std::env;
use std::fs::{File, OpenOptions};
use std::io::{IoSlice, IoSliceMut, Read, Seek, SeekFrom, Write};
use std::os::unix::io::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::net::UnixStream;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <socket-path>", args[0]);
        std::process::exit(1);
    }
    let socket_path = &args[1];

    let stream = UnixStream::connect(socket_path).expect("Failed to connect to server");
    let fd = stream.as_raw_fd();

    // Receive fd
    let mut buf = [0u8; 16];
    let mut iov = [IoSliceMut::new(&mut buf)];
    let mut cmsg_buf = nix::cmsg_space!([std::os::unix::io::RawFd; 2]);

    let msg = recvmsg::<()>(fd, &mut iov, Some(&mut cmsg_buf), MsgFlags::empty())
        .expect("recvmsg failed");

    let mut received_fd = -1;
    for cmsg in msg.cmsgs() {
        if let ControlMessageOwned::ScmRights(fds) = cmsg {
            if !fds.is_empty() {
                received_fd = fds[0];
            }
        }
    }

    if received_fd == -1 {
        eprintln!("No fd received");
        std::process::exit(1);
    }

    // Read string from received fd
    let mut file = unsafe { File::from_raw_fd(received_fd) };
    file.seek(SeekFrom::Start(0)).unwrap_or(0); // Ensure we are at the start
    let mut content = String::new();
    file.read_to_string(&mut content)
        .expect("Failed to read fd");

    // Reverse string
    let reversed: String = content.chars().rev().collect();

    // Create new fd using temp file
    let temp_path = std::env::temp_dir().join(format!("fd_echo_{}.txt", std::process::id()));
    let mut new_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp_path)
        .expect("Failed to create temp file");

    new_file
        .write_all(reversed.as_bytes())
        .expect("Failed to write to new fd");
    new_file.seek(SeekFrom::Start(0)).expect("Failed to seek");

    let new_fd = new_file.into_raw_fd();

    // Send new fd back
    let send_buf = [b'F'];
    let iov_send = [IoSlice::new(&send_buf)];
    let cmsgs = [ControlMessage::ScmRights(&[new_fd])];
    sendmsg::<()>(fd, &iov_send, &cmsgs, MsgFlags::empty(), None).expect("sendmsg failed");

    // cleanup temp file after sending
    std::fs::remove_file(temp_path).ok();

    unsafe { libc::close(new_fd) };
}
