import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// 导入 Rust 绑定（由 Neon 构建生成）
const native = require('../index.node');

// 定义 Rust 绑定的接口
interface NativeModule {
  hello: (name: string) => string;
}

// 类型断言
const nativeModule = native as NativeModule;

// 导出 Rust 绑定的函数
export const hello: (name: string) => string = nativeModule.hello;

// 也可以添加额外的 TypeScript 逻辑
export function greet(name: string): string {
  return hello(name);
}

// 默认导出整个模块
export default {
  hello,
  greet,
};