use neon::prelude::*;
use neon::types::buffer::TypedArray;
use std::cell::RefCell;
use std::io::{self, IoSlice, IoSliceMut};
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use nix::sys::socket::{recvmsg, sendmsg, ControlMessage, ControlMessageOwned, MsgFlags, UnixAddr};

// USocketWrap - 客户端 socket 包装器
pub struct USocketWrap {
    stream: RefCell<Option<UnixStream>>,
    fd: RefCell<Option<RawFd>>,
    paused: Arc<AtomicBool>,
    callback: Arc<Mutex<Option<Root<JsFunction>>>>,
    thread_handle: RefCell<Option<thread::JoinHandle<()>>>,
    stop_flag: Arc<AtomicBool>,
}

impl Finalize for USocketWrap {}

impl USocketWrap {
    pub fn new() -> Self {
        Self {
            stream: RefCell::new(None),
            fd: RefCell::new(None),
            paused: Arc::new(AtomicBool::new(true)),
            callback: Arc::new(Mutex::new(None)),
            thread_handle: RefCell::new(None),
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn connect(&self, path: &str) -> Result<RawFd, io::Error> {
        let stream = UnixStream::connect(path)?;
        let fd = stream.as_raw_fd();
        *self.fd.borrow_mut() = Some(fd);
        *self.stream.borrow_mut() = Some(stream);
        Ok(fd)
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

    pub fn read_with_fds(&self, buf: &mut [u8]) -> Result<(usize, Vec<RawFd>), io::Error> {
        let stream = self.stream.borrow();
        if let Some(stream) = stream.as_ref() {
            let raw_fd = stream.as_raw_fd();
            let mut iov = [IoSliceMut::new(buf)];
            let mut cmsg_buf = nix::cmsg_space!([RawFd; 64]);

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

    pub fn set_callback(&self, callback: Root<JsFunction>) {
        *self.callback.lock().unwrap() = Some(callback);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Relaxed);
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Relaxed);
    }

    pub fn start_polling(&self, channel: Channel) {
        let paused = self.paused.clone();
        let callback = self.callback.clone();
        let stop = self.stop_flag.clone();
        let fd = *self.fd.borrow();

        if fd.is_none() {
            return;
        }

        let fd = fd.unwrap();

        let handle = thread::spawn(move || {
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }

                if paused.load(Ordering::Relaxed) {
                    thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                }

                let mut pfd = libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                };

                let ret = unsafe { libc::poll(&mut pfd, 1, 100) };

                if ret > 0 {
                    if pfd.revents & libc::POLLIN != 0 {
                        // 有数据可读 - 先读取数据
                        let mut buf = vec![0u8; 65536];
                        let mut iov = [IoSliceMut::new(&mut buf)];
                        let mut cmsg_buf = nix::cmsg_space!([RawFd; 64]);

                        let read_result = recvmsg::<UnixAddr>(
                            fd,
                            &mut iov,
                            Some(&mut cmsg_buf),
                            MsgFlags::empty(),
                        );

                        match read_result {
                            Ok(msg) => {
                                let n = msg.bytes;
                                let mut fds = Vec::new();
                                for cmsg in msg.cmsgs() {
                                    if let ControlMessageOwned::ScmRights(received_fds) = cmsg {
                                        fds.extend(received_fds);
                                    }
                                }

                                // 消耗回调并调用
                                let cb = callback.lock().unwrap().take();
                                if let Some(cb) = cb {
                                    channel.send(move |mut cx| {
                                        let this = cx.undefined();
                                        let func = cb.into_inner(&mut cx);
                                        let event = cx.string("data");

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

                                        func.call(
                                            &mut cx,
                                            this,
                                            [event.upcast(), data, fds_array.upcast()],
                                        )?;
                                        Ok(())
                                    });
                                }
                            }
                            Err(_) => {
                                // 读取失败，可能是连接关闭
                                let cb = callback.lock().unwrap().take();
                                if let Some(cb) = cb {
                                    channel.send(move |mut cx| {
                                        let this = cx.undefined();
                                        let func = cb.into_inner(&mut cx);
                                        let event = cx.string("end");
                                        func.call(&mut cx, this, [event.upcast()])?;
                                        Ok(())
                                    });
                                }
                                break;
                            }
                        }
                    }

                    if pfd.revents & (libc::POLLHUP | libc::POLLERR) != 0 {
                        let cb = callback.lock().unwrap().take();
                        if let Some(cb) = cb {
                            channel.send(move |mut cx| {
                                let this = cx.undefined();
                                let func = cb.into_inner(&mut cx);
                                let event = cx.string("end");
                                func.call(&mut cx, this, [event.upcast()])?;
                                Ok(())
                            });
                        }
                        break;
                    }
                }
            }
        });

        *self.thread_handle.borrow_mut() = Some(handle);
    }

    pub fn shutdown(&self) -> Result<(), io::Error> {
        let stream = self.stream.borrow();
        if let Some(stream) = stream.as_ref() {
            stream.shutdown(std::net::Shutdown::Write)?;
        }
        Ok(())
    }

    pub fn close(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread_handle.borrow_mut().take() {
            let _ = handle.join();
        }
        *self.stream.borrow_mut() = None;
        *self.fd.borrow_mut() = None;
    }
}

// UServerWrap - 服务器 socket 包装器
pub struct UServerWrap {
    listener: RefCell<Option<UnixListener>>,
    fd: RefCell<Option<RawFd>>,
    paused: Arc<AtomicBool>,
    callback: Arc<Mutex<Option<Root<JsFunction>>>>,
    thread_handle: RefCell<Option<thread::JoinHandle<()>>>,
    stop_flag: Arc<AtomicBool>,
}

impl Finalize for UServerWrap {}

impl UServerWrap {
    pub fn new() -> Self {
        Self {
            listener: RefCell::new(None),
            fd: RefCell::new(None),
            paused: Arc::new(AtomicBool::new(true)),
            callback: Arc::new(Mutex::new(None)),
            thread_handle: RefCell::new(None),
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn listen(&self, path: &str, backlog: i32) -> Result<RawFd, io::Error> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        listener.set_nonblocking(true)?;
        let fd = listener.as_raw_fd();
        *self.fd.borrow_mut() = Some(fd);
        *self.listener.borrow_mut() = Some(listener);
        let _ = backlog;
        Ok(fd)
    }

    pub fn set_callback(&self, callback: Root<JsFunction>) {
        *self.callback.lock().unwrap() = Some(callback);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Relaxed);
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Relaxed);
    }

    pub fn start_accepting(&self, channel: Channel) {
        let paused = self.paused.clone();
        let callback = self.callback.clone();
        let stop = self.stop_flag.clone();
        let fd = *self.fd.borrow();

        if fd.is_none() {
            return;
        }

        let fd = fd.unwrap();

        let handle = thread::spawn(move || loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            if paused.load(Ordering::Relaxed) {
                thread::sleep(std::time::Duration::from_millis(10));
                continue;
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
                    let cb = callback.lock().unwrap().take();
                    if let Some(cb) = cb {
                        channel.send(move |mut cx| {
                            let this = cx.undefined();
                            let func = cb.into_inner(&mut cx);
                            let event = cx.string("accept");
                            let fd_val = cx.number(client_fd as f64);
                            func.call(&mut cx, this, [event.upcast(), fd_val.upcast()])?;
                            Ok(())
                        });
                    }
                }
            }
        });

        *self.thread_handle.borrow_mut() = Some(handle);
    }

    pub fn close(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread_handle.borrow_mut().take() {
            let _ = handle.join();
        }
        *self.listener.borrow_mut() = None;
        *self.fd.borrow_mut() = None;
    }
}

// Neon 导出函数
fn usocket_wrap_new(mut cx: FunctionContext) -> JsResult<JsValue> {
    let wrap = USocketWrap::new();
    let callback_arg = cx.argument_opt(0);
    if let Some(cb) = callback_arg {
        if let Ok(func) = cb.downcast::<JsFunction, _>(&mut cx) {
            wrap.set_callback(func.root(&mut cx));
        }
    }
    Ok(cx.boxed(wrap).upcast())
}

fn usocket_wrap_connect(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let path = cx.argument::<JsString>(1)?.value(&mut cx);
    match usocket_wrap.connect(&path) {
        Ok(fd) => Ok(cx.number(fd as f64)),
        Err(e) => cx.throw_error(format!("Connect failed: {}", e)),
    }
}

fn usocket_wrap_adopt(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let fd = cx.argument::<JsNumber>(1)?.value(&mut cx) as RawFd;
    match usocket_wrap.adopt(fd) {
        Ok(_) => Ok(cx.undefined()),
        Err(e) => cx.throw_error(format!("Adopt failed: {}", e)),
    }
}

fn usocket_wrap_set_callback(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    usocket_wrap.set_callback(callback.root(&mut cx));
    Ok(cx.undefined())
}

fn usocket_wrap_write(mut cx: FunctionContext) -> JsResult<JsValue> {
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
        Ok(n) => Ok(cx.number(n as f64).upcast()),
        Err(e) => Ok(cx.error(format!("Write failed: {}", e))?.upcast()),
    }
}

fn usocket_wrap_read(mut cx: FunctionContext) -> JsResult<JsObject> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let size = cx.argument::<JsNumber>(1)?.value(&mut cx) as usize;

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
        Err(e) => cx.throw_error(format!("Read failed: {}", e)),
    }
}

fn usocket_wrap_resume(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    usocket_wrap.resume();
    Ok(cx.undefined())
}

fn usocket_wrap_pause(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    usocket_wrap.pause();
    Ok(cx.undefined())
}

fn usocket_wrap_start_polling(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let channel = cx.channel();
    usocket_wrap.start_polling(channel);
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

fn userver_wrap_new(mut cx: FunctionContext) -> JsResult<JsValue> {
    let wrap = UServerWrap::new();
    let callback_arg = cx.argument_opt(0);
    if let Some(cb) = callback_arg {
        if let Ok(func) = cb.downcast::<JsFunction, _>(&mut cx) {
            wrap.set_callback(func.root(&mut cx));
        }
    }
    Ok(cx.boxed(wrap).upcast())
}

fn userver_wrap_set_callback(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    userver_wrap.set_callback(callback.root(&mut cx));
    Ok(cx.undefined())
}

fn userver_wrap_listen(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    let path = cx.argument::<JsString>(1)?.value(&mut cx);
    let backlog = cx.argument::<JsNumber>(2)?.value(&mut cx) as i32;
    match userver_wrap.listen(&path, backlog) {
        Ok(fd) => Ok(cx.number(fd as f64)),
        Err(e) => cx.throw_error(format!("Listen failed: {}", e)),
    }
}

fn userver_wrap_resume(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    userver_wrap.resume();
    Ok(cx.undefined())
}

fn userver_wrap_pause(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    userver_wrap.pause();
    Ok(cx.undefined())
}

fn userver_wrap_start_accepting(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    let channel = cx.channel();
    userver_wrap.start_accepting(channel);
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
    cx.export_function("USocketWrap_set_callback", usocket_wrap_set_callback)?;
    cx.export_function("USocketWrap_write", usocket_wrap_write)?;
    cx.export_function("USocketWrap_read", usocket_wrap_read)?;
    cx.export_function("USocketWrap_resume", usocket_wrap_resume)?;
    cx.export_function("USocketWrap_pause", usocket_wrap_pause)?;
    cx.export_function("USocketWrap_start_polling", usocket_wrap_start_polling)?;
    cx.export_function("USocketWrap_shutdown", usocket_wrap_shutdown)?;
    cx.export_function("USocketWrap_close", usocket_wrap_close)?;

    cx.export_function("UServerWrap", userver_wrap_new)?;
    cx.export_function("UServerWrap_set_callback", userver_wrap_set_callback)?;
    cx.export_function("UServerWrap_listen", userver_wrap_listen)?;
    cx.export_function("UServerWrap_resume", userver_wrap_resume)?;
    cx.export_function("UServerWrap_pause", userver_wrap_pause)?;
    cx.export_function("UServerWrap_start_accepting", userver_wrap_start_accepting)?;
    cx.export_function("UServerWrap_close", userver_wrap_close)?;

    Ok(())
}
