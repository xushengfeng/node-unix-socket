use neon::prelude::*;
use neon::types::buffer::TypedArray;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};

pub struct USocketWrap {
    stream: RefCell<Option<UnixStream>>,
    fd: RefCell<Option<RawFd>>,
    fds_queue: RefCell<VecDeque<RawFd>>,
}

impl Finalize for USocketWrap {}

impl USocketWrap {
    pub fn new() -> Self {
        Self {
            stream: RefCell::new(None),
            fd: RefCell::new(None),
            fds_queue: RefCell::new(VecDeque::new()),
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
        let mut stream = self.stream.borrow_mut();
        if let Some(stream) = stream.as_mut() {
            let mut written = 0;
            if let Some(data) = data {
                written = stream.write(data)?;
            }
            if let Some(fds) = fds {
                let mut fds_queue = self.fds_queue.borrow_mut();
                for fd in fds {
                    fds_queue.push_back(*fd);
                }
            }
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

    pub fn shutdown(&self) -> Result<(), io::Error> {
        let stream = self.stream.borrow();
        if let Some(stream) = stream.as_ref() {
            stream.shutdown(std::net::Shutdown::Both)?;
        }
        Ok(())
    }

    pub fn close(&self) {
        *self.stream.borrow_mut() = None;
        *self.fd.borrow_mut() = None;
    }
}

pub struct UServerWrap {
    listener: RefCell<Option<UnixListener>>,
    fd: RefCell<Option<RawFd>>,
}

impl Finalize for UServerWrap {}

impl UServerWrap {
    pub fn new() -> Self {
        Self {
            listener: RefCell::new(None),
            fd: RefCell::new(None),
        }
    }

    pub fn listen(&self, path: &str, backlog: i32) -> Result<(), io::Error> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
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

    pub fn close(&self) {
        *self.listener.borrow_mut() = None;
        *self.fd.borrow_mut() = None;
    }
}

fn usocket_wrap_new(mut cx: FunctionContext) -> JsResult<JsBox<USocketWrap>> {
    Ok(cx.boxed(USocketWrap::new()))
}

fn usocket_wrap_connect(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let usocket_wrap = cx.argument::<JsBox<USocketWrap>>(0)?;
    let path = cx.argument::<JsString>(1)?.value(&mut cx);
    match usocket_wrap.connect(&path) {
        Ok(_) => Ok(cx.undefined()),
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

fn userver_wrap_listen(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let userver_wrap = cx.argument::<JsBox<UServerWrap>>(0)?;
    let path = cx.argument::<JsString>(1)?.value(&mut cx);
    let backlog = cx.argument::<JsNumber>(2)?.value(&mut cx) as i32;
    match userver_wrap.listen(&path, backlog) {
        Ok(_) => Ok(cx.undefined()),
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
    cx.export_function("USocketWrap_shutdown", usocket_wrap_shutdown)?;
    cx.export_function("USocketWrap_close", usocket_wrap_close)?;

    cx.export_function("UServerWrap", userver_wrap_new)?;
    cx.export_function("UServerWrap_listen", userver_wrap_listen)?;
    cx.export_function("UServerWrap_accept", userver_wrap_accept)?;
    cx.export_function("UServerWrap_close", userver_wrap_close)?;

    Ok(())
}
