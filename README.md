# myde-unix-socket

高性能的 Node.js Unix socket 库，使用 Rust (Neon) 实现，支持文件描述符传递 (SCM_RIGHTS)。

## 特性

- 🚀 **高性能** - 使用 Rust 实现，基于 poll 事件循环
- 📁 **文件描述符传递** - 支持通过 Unix socket 传递文件描述符 (SCM_RIGHTS)
- 📡 **事件驱动** - 基于 `data` 事件接收数据
- 📦 **TypeScript** - 完整的类型定义

## 安装

```bash
pnpm add myde-unix-socket
```

## 快速开始

### 服务器

```typescript
import { UServer, USocket } from "myde-unix-socket";

const server = new UServer();
server.listen("/tmp/my-socket");

server.on("connection", (socket) => {
    socket.on("data", (data: Buffer, fds: number[]) => {
        console.log("Received:", data.toString());
    });

    socket.write(Buffer.from("Hello!"));
});

server.resume(); // 开始接受连接
```

### 客户端

```typescript
import { USocket } from "myde-unix-socket";

const client = new USocket("/tmp/my-socket");

client.on("data", (data: Buffer, fds: number[]) => {
    console.log("Received:", data.toString());
});

client.on("connect", () => {
    client.write(Buffer.from("Hello Server!"));
});
```

### 事件驱动接收数据

```typescript
const server = new UServer();
server.listen("/tmp/test");
server.resume();

server.on("connection", (socket) => {
    socket.on("data", (data: Buffer, fds: number[]) => {
        console.log("Data:", data.toString());
        console.log("FDs:", fds);
    });
});

const client = new USocket("/tmp/test");
client.write(Buffer.from("message1"));
client.write(Buffer.from("message2"));
```

### 文件描述符传递

```typescript
import * as fs from "fs";

// 服务器
server.on("connection", (socket) => {
    socket.on("data", (data, fds) => {
        if (fds.length > 0) {
            const content = fs.readFileSync(fds[0], "utf-8");
            console.log(content);
            fs.closeSync(fds[0]);
        }
    });
});

// 客户端
const fd = fs.openSync("/tmp/file.txt", "r");
client.write({ data: Buffer.from("fd"), fds: [fd] });
fs.closeSync(fd);
```

## 构建

```bash
pnpm install
pnpm run build
pnpm test
```

**脚本:**

- `pnpm run build` - 完整构建
- `pnpm run build:rust` - 构建 Rust 模块
- `pnpm run build:ts` - 构建 TypeScript
- `pnpm test` - 运行测试
- `pnpm run test:rust` - 运行 Rust 测试

## 技术栈

- **Rust** + **nix** - Unix socket 实现
- **Neon** - Rust/Node.js 桥接
- **Vite** - 打包
- **Vitest** - 测试
