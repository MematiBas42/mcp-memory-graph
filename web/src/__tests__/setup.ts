import "@testing-library/jest-dom/vitest"
import { afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

class LocalStorageMock implements Storage {
  private store: Record<string, string> = {}
  get length() {
    return Object.keys(this.store).length
  }
  clear() {
    this.store = {}
  }
  getItem(key: string) {
    return this.store[key] ?? null
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value)
  }
  removeItem(key: string) {
    delete this.store[key]
  }
  key(index: number) {
    return Object.keys(this.store)[index] ?? null
  }
}

try {
  window.localStorage.getItem("test")
} catch {
  const mock = new LocalStorageMock()
  Object.defineProperty(window, "localStorage", {
    value: mock,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    writable: true,
    configurable: true,
  })
}

afterEach(() => {
  cleanup()
})
