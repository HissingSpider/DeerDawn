import * as Sentry from '@sentry/nextjs';
import type { NextPage } from 'next';
import type { ErrorProps } from 'next/error';
import NextErrorComponent from 'next/error';

/**
 * Pages Router needs this file for Sentry to see errors thrown during SSR.
 * Next renders _error for them and reports nothing on its own; the await
 * matters because a serverless function can terminate before an unawaited
 * send flushes.
 */
const CustomErrorComponent: NextPage<ErrorProps> = (props) => (
  <NextErrorComponent statusCode={props.statusCode} />
);

CustomErrorComponent.getInitialProps = async (contextData) => {
  await Sentry.captureUnderscoreErrorException(contextData);
  return NextErrorComponent.getInitialProps(contextData);
};

export default CustomErrorComponent;
