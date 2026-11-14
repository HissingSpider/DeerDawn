import { isApiError } from '@/lib/api';

type AuthMode = 'login' | 'signup';

function hasIssueText(details: unknown, matcher: (text: string) => boolean) {
  if (!Array.isArray(details)) return false;
  return details.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const message = 'message' in item && typeof item.message === 'string' ? item.message : '';
    const code = 'code' in item && typeof item.code === 'string' ? item.code : '';
    return matcher(`${message} ${code}`.toLowerCase());
  });
}

export function normalizeAuthError(error: unknown, mode: AuthMode) {
  if (isApiError(error)) {
    const message = error.message.toLowerCase();

    if (error.code === 'network_unreachable') {
      return 'DeerDawn could not reach the local API. Make sure the API is running on port 8080, then try again.';
    }

    if (error.code === 'network_timeout') {
      return 'The request took too long. Try again in a few seconds.';
    }

    if (error.status === 409 || message.includes('already exists') || message.includes('user exists')) {
      return mode === 'signup'
        ? 'An account with this email already exists. Sign in instead.'
        : 'This email already has an account. Try signing in.';
    }

    if (error.status === 401 || message.includes('invalid credentials')) {
      return 'Email or password is incorrect.';
    }

    if (hasIssueText(error.details, (text) => text.includes('at least 8') || text.includes('too_small'))) {
      return 'Use a password with at least 8 characters.';
    }

    if (message.includes('invalid request')) {
      return mode === 'signup'
        ? 'Please check your email and password, then try again.'
        : 'Please enter a valid email and password.';
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return mode === 'signup' ? 'We could not create your account.' : 'We could not sign you in.';
}
