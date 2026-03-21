import { describe, it, expect } from 'vitest';
import { hello, greet } from './index';

describe('unix-socket', () => {
  it('hello function returns greeting', () => {
    expect(hello('World')).toBe('hello World');
    expect(hello('Alice')).toBe('hello Alice');
  });

  it('greet function delegates to hello', () => {
    expect(greet('Bob')).toBe('hello Bob');
  });

  it('default export contains hello and greet', async () => {
    const mod = await import('./index');
    expect(mod.default.hello).toBe(hello);
    expect(mod.default.greet).toBe(greet);
  });
});