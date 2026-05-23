import { AxiosError } from 'axios';

export interface NormalizedPublisherError {
  code: string;
  message: string;
  isAuthError: boolean;
}

export function normalizePublisherError(
  error: unknown,
): NormalizedPublisherError {
  const axiosError = error as AxiosError<any>;
  const apiError = axiosError.response?.data?.error;
  const code =
    apiError?.code?.toString() ??
    axiosError.response?.status?.toString() ??
    'UNKNOWN';
  const rawMessage =
    apiError?.error_user_msg ??
    apiError?.message ??
    axiosError.message ??
    'Unknown publishing error';

  return {
    code,
    message: humanizePublisherMessage(code, rawMessage),
    isAuthError:
      code === '190' ||
      code === '401' ||
      axiosError.response?.status === 401 ||
      /token|permission|oauth/i.test(rawMessage),
  };
}

function humanizePublisherMessage(code: string, message: string): string {
  if (code === '190' || /token/i.test(message)) {
    return 'The channel token is invalid or expired. Reconnect the social channel, then retry this task.';
  }
  if (/permission|OAuthException/i.test(message)) {
    return 'The social account is missing a required publishing permission. Review the channel connection and app permissions.';
  }
  if (/media|image|video|format|aspect/i.test(message)) {
    return `The media does not meet the platform requirements. ${message}`;
  }
  return message;
}
