use neon::prelude::*;
use neon::types::buffer::TypedArray;
use std::cell::RefCell;
use std::io::{self, IoSlice, IoSliceMut, Read};
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use nix::sys::socket::{recvmsg, sendmsg, ControlMessage, ControlMessageOwned, MsgFlags, UnixAddr};

pub struct USocketWrap {
    stream: RefCell<Option<UnixStream>>,
    fd: RefCell<Option<RawFd>>,
    readable_callback: Arc<Mutex<Option<Root<JsFunction>>>>,
    end_callback: Arc<Mutex<Option<Root<JsFunction>>>>,
    reading_thread: RefCell<Option<thread::JoinHandle<()>>>,
    stop_reading: Arc<AtomicBool>,
}

impl Finalize for USocketWrap {}

impl USocketWrap {
    pub fn new() -> Self {
        Self {
            stream: RefCell::new(None),
            fd: RefCell::new(None),
            readable_callback: Arc::new(Mutex::new(None)),
            end_callback: Arc::new(Mutex::new(None)),
            reading_thread: RefCell::new(None),
            stop_reading: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn connect(&self, path: &str) -> Result<(), io::Error> {
        let stream = UnixStream::connect(path)?;
        *self.fd.borrow_mut() = Some(stream.as_raw_fd());
        *self.stream.borrow_mut() = Some(stream);
        Ok(())
    }

    pub fn adopt(&self, fd: RawFd) -> Result<(), io::Error> {
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        *self.fd.borrow_mut() = Some(fd);
        *self.stream.borrow_mut() = Some(stream);
        Ok(())
    }

    pub fn write(&self, data: Option<&[u8]>, fds: Option<&[RawFd]>) -> Result<usize, io::Error> {
        let stream = self.stream.borrow();
        if let Some(stream) = stream.as_ref() {
            let raw_fd = stream.as_raw_fd();

            let data_buf = data.unwrap_or(&[]);
            let iov = [IoSlice::new(data_buf)];

            let written = if let Some(fds) = fds {
                let cmsg = ControlMessage::ScmRights(fds);
                sendmsg::<UnixAddr>(raw_fd, &iov, &[cmsg], MsgFlags::empty(), None)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?
            } else {
                sendmsg::<UnixAddr>(raw_fd, &iov, &[], MsgFlags::empty(), None)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?
            };

            Ok(written)
        } else {
            Err(io::Error::new(io::ErrorKind::NotConnected, "Not connected"))
        }
    }

    pub fn read(&self, buf: &mut [u8]) -> Result<usize, io::Error> {
        let mut stream = self.stream.borrow_mut();
        if let Some(stream) = stream.as_mut() {
            stream.read(buf)
        } else {
            Err(io::Error::new(io::ErrorKind::NotConnected, "Not connected"))
        }
    }

    pub fn read_with_fds(&self, buf: &mut [u8]) -> Result<(usize, Vec<RawFd>), io::Error> {
        let stream = self.stream.borrow();
        if let Some(stream) = stream.as_ref() {
            let raw_fd = stream.as_raw_fd();
            let mut iov = [IoSliceMut::new(buf)];

            let mut cmsg_buf = nix::cmsg_space!([RawFd; 3]);

            let msg = recvmsg::<UnixAddr>(raw_fd, &mut iov, Some(&mut cmsg_buf), MsgFlags::empty())
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            let mut fds = Vec::new();
            for cmsg in msg.cmsgs() {
                if let ControlMessageOwned::ScmRights(received_fds) = cmsg {
                    fds.extend(received_fds);
                }
            }

            Ok((msg.bytes, fds))
        } else {
            Err(io::Error::new(io::ErrorKind::NotConnected, "Not connected"))
        }
    }

    pub fn set_readable_callback(&self, callback: Root<JsFunction>) {
        *self.readable_callback.lock().unwrap() = Some(callback);
    }

    pub fn set_end_callback(&self, callback: Root<JsFunction>) {
        *self.end_callback.lock().unwrap() = Some(callback);
    }

    pub fn start_reading(&self, channel: Channel) {
        let stop = self.stop_reading.clone();
        let readable_cb = self.readable_callback.clone();
        let end_cb = self.end_callback.clone();
        let fd = *self.fd.borrow();

        if fd.is_none() {
            return;
        }

        let fd = fd.unwrap();

        let handle = thread::spawn(move || loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let mut pfd = libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            };

            let ret = unsafe { libc::poll(&mut pfd, 1, 100) };

            if ret > 0 {
                if pfd.revents & libc::POLLIN != 0 {
                    // 临时取出回调
                    let cb = readable_cb.lock().unwrap().take();
                    if let Some(callback) = cb {
                        let cb_clone = readable_cb.clone();
                        channel.send(move |mut cx| {
                            let this = cx.undefined();
                            let func = callback.into_inner(&mut cx);
                            let args: Vec<Handle<JsValue>> = vec![];
                            func.call(&mut cx, this, args)?;

                            // 注意：Root 已经被消耗，无法放回
                            // 需要在 JS 端重新设置回调
                            Ok(())
                        });
                    }
                }

                if pfd.revents & (libc::POLLHUP | libc::POLLERR) != 0 {
                    let end = end_cb.lock().unwrap().take();
                    if let Some(cb) = end {
                        channel.send(move |mut cx| {
                            let this = cx.undefined();
                            let callback = cb.into_inner(&mut cx);
                            let args: Vec<Handle<JsValue>> = vec![];
                            callback.call(&mut cx, this, args)?;
                            Ok(())
                        });
                    }
                    break;
                }
            }
        });

        *self.reading_thread.borrow_mut() = Some(handle);
    }

    pub fn stop_reading(&self) {
        self.stop_reading.store(true, Ordering::Relaxed);
        if let Some(handle) = self.reading_thread.borrow_mut().take() {
            let _ = handle.join();
        }
    }

    pub fn shutdown(&self) -> Result<(), io::Error> {
        let stream = self.stream.borrow();
        if let Some(stream) = stream.as_ref() {
            stream.shutdown(std::net::Shutdown::Both)?;
        }
        Ok(())
    }

    pub fn close(&self) {
        self.stop_reading();
        *self.stream.borrow_mut() = None;
        *self.fd.borrow_mut() = None;
    }
}

pub struct UServerWrap {
    listener: RefCell<Option<UnixListener>>,
    fd: RefCell<Option<RawFd>>,
    connection_callback: Arc<Mutex<Option<Root<JsFunction>>>>,
    listening_thread: RefCell<Option<thread::JoinHandle<()>>>,
    stop_listening: Arc<AtomicBool>,
}

impl Finalize for UServerWrap {}

impl UServerWrap {
    pub fn new() -> Self {
        Self {
            listener: RefCell::new(None),
            fd: RefCell::new(None),
            connection_callback: Arc::new(Mutex::new(None)),
            listening_thread: RefCell::new(None),
            stop_listening: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn listen(&self, path: &str, backlog: i32) -> Result<(), io::Error> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        listener.set_nonblocking(true)?;
        *self.fd.borrow_mut() = Some(listener.as_raw_fd());
        *self.listener.borrow_mut() = Some(listener);
        let _ = backlog;
        Ok(())
    }

    pub fn accept(&self) -> Result<Option<RawFd>, io::Error> {
        let listener = self.listener.borrow();
        if let Some(listener) = listener.as_ref() {
            match listener.accept() {
                Ok((stream, _)) => {
                    let fd = stream.as_raw_fd();
                    std::mem::forget(stream);
                    Ok(Some(fd))
                }
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
                Err(e) => Err(e),
            }
        } else {
            Err(io::Error::new(io::ErrorKind::NotConnected, "Not listening"))
        }
    }

    pub fn set_connection_callback(&self, callback: Root<JsFunction>) {
        *self.connection_callback.lock().unwrap() = Some(callback);
    }

    pub fn start_accepting(&self, channel: Channel) {
        let stop = self.stop_listening.clone();
        let conn_cb = self.connection_callback.clone();
        let fd = *self.fd.borrow();

        if fd.is_none() {
            return;
        }

        let fd = fd.unwrap();

        let handle = thread::spawn(move || loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let mut pfd = libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            };

            let ret = unsafe { libc::poll(&mut pfd, 1, 100) };

            if ret > 0 && pfd.revents & libc::POLLIN != 0 {
                let client_fd = unsafe {
                    let mut addr: libc::sockaddr_un = std::mem::zeroed();
                    let mut len = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
                    libc::accept(fd, &mut addr as *mut _ as *mut _, &mut len)
                };

                if client_fd >= 0 {
                    let cb = conn_cb.lock().unwrap().take();
                    if let Some(callback) = cb {
                        channel.send(move |mut cx| {
                            let this = cx.undefined();
                            let func = callback.into_inner(&mut cx);
                            let fd_arg = cx.number(client_fd as f64);
                            let args: Vec<Handle<JsValue>> = vec![fd_arg.upcast()];
                            func.call(&mut cx, this, args)?;
                            Ok(())
                        });
                    }
                }
            }
        });

        *self.listening_thread.borrow_mut() = Some(handle);
    }

    pub fn stop_accepting(&self) {
        self.stop_listening.store(true, Ordering::Relaxed);
        if let Some(handle) = self.listening_thread.borrow_mut().take() {
            let _ = handle.join();
        }
    }

    pub fn close(&self) {
        self.stop_accepting();
        *self.listener.borrow_mut() = None;
        *self.fd.borrow_mut() = None;
    }
}

fn usocket_wrap_new(mut cx: FunctionContext) -> JsResult<JsBox<USocketWrap>> {
    Ok(cx.boxed(USocketWrap::new()))
}

fn usocket_wrap_connect(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let path = cx.argument::<JsString>(1)?.value(&mut cx);
    match usocket_wrap.connect(&path) {
        Ok(_) => {
            let fd = usocket_wrap.fd.borrow();
            Ok(cx.number(fd.unwrap_or(-1) as f64))
        }
        Err(e) => cx.throw_error(format!("Connect failed: {}", e)),
    }
}

fn usocket_wrap_adopt(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let fd = cx.argument::<JsNumber>(1)?.value(&mut cx) as RawFd;
    match usocket_wrap.adopt(fd) {
        Ok(_) => Ok(cx.number(fd as f64)),
        Err(e) => cx.throw_error(format!("Adopt failed: {}", e)),
    }
}

fn usocket_wrap_write(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let data_opt = cx.argument_opt(1);
    let fds_opt = cx.argument_opt(2);

    let data_vec;
    let data_bytes = if let Some(data) = data_opt {
        if data.is_a::<JsBuffer, _>(&mut cx) {
            let buffer = data.downcast_or_throw::<JsBuffer, _>(&mut cx)?;
            data_vec = buffer.as_slice(&cx).to_vec();
            Some(data_vec.as_slice())
        } else {
            None
        }
    } else {
        None
    };

    let fds_vec;
    let fds_slice = if let Some(fds) = fds_opt {
        if fds.is_a::<JsArray, _>(&mut cx) {
            let array = fds.downcast_or_throw::<JsArray, _>(&mut cx)?;
            let mut vec = Vec::new();
            for i in 0..array.len(&mut cx) {
                let fd = array.get::<JsNumber, _, _>(&mut cx, i)?;
                vec.push(fd.value(&mut cx) as RawFd);
            }
            fds_vec = vec;
            Some(fds_vec.as_slice())
        } else {
            None
        }
    } else {
        None
    };

    match usocket_wrap.write(data_bytes, fds_slice) {
        Ok(n) => Ok(cx.number(n as f64)),
        Err(e) => cx.throw_error(format!("Write failed: {}", e)),
    }
}

fn usocket_wrap_read(mut cx: FunctionContext) -> JsResult<JsBuffer> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let size = cx.argument::<JsNumber>(1)?.value(&mut cx) as usize;
    let _copy = cx
        .argument_opt(2)
        .and_then(|v| v.downcast::<JsBoolean, _>(&mut cx).ok())
        .map(|v| v.value(&mut cx))
        .unwrap_or(true);

    let mut buf = vec![0u8; size];
    match usocket_wrap.read(&mut buf) {
        Ok(n) => {
            let mut result = JsBuffer::new(&mut cx, n)?;
            let slice = result.as_mut_slice(&mut cx);
            slice.copy_from_slice(&buf[..n]);
            Ok(result)
        }
        Err(e) => cx.throw_error(format!("Read failed: {}", e)),
    }
}

fn usocket_wrap_read_with_fds(mut cx: FunctionContext) -> JsResult<JsObject> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let size = cx.argument::<JsNumber>(1)?.value(&mut cx) as usize;
    let _copy = cx
        .argument_opt(2)
        .and_then(|v| v.downcast::<JsBoolean, _>(&mut cx).ok())
        .map(|v| v.value(&mut cx))
        .unwrap_or(true);

    let mut buf = vec![0u8; size];

    match usocket_wrap.read_with_fds(&mut buf) {
        Ok((n, fds)) => {
            let data = if n > 0 {
                let mut result = JsBuffer::new(&mut cx, n)?;
                let slice = result.as_mut_slice(&mut cx);
                slice.copy_from_slice(&buf[..n]);
                result.as_value(&mut cx)
            } else {
                cx.null().upcast()
            };

            let fds_array = JsArray::new(&mut cx, fds.len());
            for (i, fd) in fds.iter().enumerate() {
                let fd_js = cx.number(*fd as f64);
                fds_array.set(&mut cx, i as u32, fd_js)?;
            }

            let obj = JsObject::new(&mut cx);
            obj.set(&mut cx, "data", data)?;
            obj.set(&mut cx, "fds", fds_array)?;
            Ok(obj)
        }
        Err(e) => cx.throw_error(format!("Read with fds failed: {}", e)),
    }
}

fn usocket_wrap_on_readable(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let cb_root = callback.root(&mut cx);
    usocket_wrap.set_readable_callback(cb_root);
    Ok(cx.undefined())
}

fn usocket_wrap_on_end(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let cb_root = callback.root(&mut cx);
    usocket_wrap.set_end_callback(cb_root);
    Ok(cx.undefined())
}

fn usocket_wrap_start_reading(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let channel = cx.channel();
    usocket_wrap.start_reading(channel);
    Ok(cx.undefined())
}

fn usocket_wrap_stop_reading(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    usocket_wrap.stop_reading();
    Ok(cx.undefined())
}

fn usocket_wrap_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    match usocket_wrap.shutdown() {
        Ok(_) => Ok(cx.undefined()),
        Err(e) => cx.throw_error(format!("Shutdown failed: {}", e)),
    }
}

fn usocket_wrap_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    usocket_wrap.close();
    Ok(cx.undefined())
}

fn userver_wrap_new(mut cx: FunctionContext) -> JsResult<JsBox<UServerWrap>> {
    Ok(cx.boxed(UServerWrap::new()))
}

fn userver_wrap_listen(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    let path = cx.argument::<JsString>(1)?.value(&mut cx);
    let backlog = cx.argument::<JsNumber>(2)?.value(&mut cx) as i32;
    match userver_wrap.listen(&path, backlog) {
        Ok(_) => {
            let fd = userver_wrap.fd.borrow();
            Ok(cx.number(fd.unwrap_or(-1) as f64))
        }
        Err(e) => cx.throw_error(format!("Listen failed: {}", e)),
    }
}

fn userver_wrap_accept(mut cx: FunctionContext) -> JsResult<JsValue> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    match userver_wrap.accept() {
        Ok(Some(fd)) => Ok(cx.number(fd as f64).upcast()),
        Ok(None) => Ok(cx.null().upcast()),
        Err(e) => cx.throw_error(format!("Accept failed: {}", e)),
    }
}

fn userver_wrap_on_connection(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let cb_root = callback.root(&mut cx);
    userver_wrap.set_connection_callback(cb_root);
    Ok(cx.undefined())
}

fn userver_wrap_start_accepting(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    let channel = cx.channel();
    userver_wrap.start_accepting(channel);
    Ok(cx.undefined())
}

fn userver_wrap_stop_accepting(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    userver_wrap.stop_accepting();
    Ok(cx.undefined())
}

fn userver_wrap_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    userver_wrap.close();
    Ok(cx.undefined())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("USocketWrap", usocket_wrap_new)?;
    cx.export_function("USocketWrap_connect", usocket_wrap_connect)?;
    cx.export_function("USocketWrap_adopt", usocket_wrap_adopt)?;
    cx.export_function("USocketWrap_write", usocket_wrap_write)?;
    cx.export_function("USocketWrap_read", usocket_wrap_read)?;
    cx.export_function("USocketWrap_read_with_fds", usocket_wrap_read_with_fds)?;
    cx.export_function("USocketWrap_on_readable", usocket_wrap_on_readable)?;
    cx.export_function("USocketWrap_on_end", usocket_wrap_on_end)?;
    cx.export_function("USocketWrap_start_reading", usocket_wrap_start_reading)?;
    cx.export_function("USocketWrap_stop_reading", usocket_wrap_stop_reading)?;
    cx.export_function("USocketWrap_shutdown", usocket_wrap_shutdown)?;
    cx.export_function("USocketWrap_close", usocket_wrap_close)?;

    cx.export_function("UServerWrap", userver_wrap_new)?;
    cx.export_function("UServerWrap_listen", userver_wrap_listen)?;
    cx.export_function("UServerWrap_accept", userver_wrap_accept)?;
    cx.export_function("UServerWrap_on_connection", userver_wrap_on_connection)?;
    cx.export_function("UServerWrap_start_accepting", userver_wrap_start_accepting)?;
    cx.export_function("UServerWrap_stop_accepting", userver_wrap_stop_accepting)?;
    cx.export_function("UServerWrap_close", userver_wrap_close)?;

    Ok(())
}
