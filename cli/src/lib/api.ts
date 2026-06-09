import type { AuthConfig } from "./types.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private readonly base: string;

  constructor(private readonly auth: AuthConfig) {
    this.base = auth.worker_url.replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.auth.access_token}`,
      "Content-Type": "application/json",
    };
  }

  private async check(res: Response, label: string): Promise<Response> {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(res.status, `${label} → ${res.status}: ${body}`);
    }
    return res;
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { headers: this.headers() });
    await this.check(res, `GET ${path}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    await this.check(res, `POST ${path}`);
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    await this.check(res, `PATCH ${path}`);
    return res.json() as Promise<T>;
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(`${this.base}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (res.status !== 404) await this.check(res, `DELETE ${path}`);
  }
}
