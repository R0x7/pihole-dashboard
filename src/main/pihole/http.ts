// Minimal HTTP(S) transport for the Pi-hole client, built on Node built-ins.
import http from 'node:http'
import https from 'node:https'

export interface HttpRequestOptions {
  url: URL
  method: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  /** Already-serialised request body. */
  body?: string
  timeoutMs: number
  /** Skip certificate verification for this request only. */
  allowSelfSigned: boolean
}

export interface HttpResponse {
  status: number
  body: string
}

/** Thrown (as a rejection) when the whole request exceeds its time budget. */
export class RequestTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'
  constructor() {
    super('Request timed out')
    this.name = 'RequestTimeoutError'
  }
}

const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * Perform one request. Resolves for any HTTP status; rejects with the raw
 * Node error (or RequestTimeoutError) on transport failures.
 */
export function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const { url } = options
    const isHttps = url.protocol === 'https:'
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(options.body))
    }

    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method,
      headers,
      // A fresh connection per request: no shared/global agent, so the TLS
      // option below can never leak into other requests in the process.
      agent: false
    }
    if (isHttps) {
      requestOptions.rejectUnauthorized = !options.allowSelfSigned
    }

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const req = (isHttps ? https : http).request(requestOptions, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error('Response too large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        finish(() =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      })
      res.on('error', (err) => finish(() => reject(err)))
    })

    const timer = setTimeout(() => {
      const err = new RequestTimeoutError()
      finish(() => reject(err))
      req.destroy(err)
    }, options.timeoutMs)

    req.on('error', (err) => finish(() => reject(err)))
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}
