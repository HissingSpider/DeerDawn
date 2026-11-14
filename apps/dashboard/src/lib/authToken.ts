let runtimeToken: string | null = null;
let runtimeTokenGetter: (() => Promise<string | null>) | null = null;

export function getRuntimeAuthToken(): string | null {
  return runtimeToken;
}

export function setRuntimeAuthToken(token: string | null) {
  runtimeToken = token;
}

export function setRuntimeAuthTokenGetter(getter: (() => Promise<string | null>) | null) {
  runtimeTokenGetter = getter;
}

export async function resolveRuntimeAuthToken(): Promise<string | null> {
  if (runtimeTokenGetter) {
    const token = await runtimeTokenGetter();
    runtimeToken = token;
    return token;
  }

  return runtimeToken;
}
