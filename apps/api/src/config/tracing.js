const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-node');

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: 'deerdawn-api',
  }),
  spanProcessor: new SimpleSpanProcessor(new OTLPTraceExporter()),
});

sdk.start();

// NO SIGTERM handler here, and in particular no process.exit(). server.js owns shutdown:
// it registers its own SIGTERM handler that drains in-flight HTTP requests, stops the
// scheduler, and closes Redis/PG. A competing handler here exited the process as soon as
// span flushing finished — which is far faster than draining — so it won the race on
// essentially every deploy and truncated the real graceful shutdown.
// server.js awaits shutdownTracing() as part of that sequence instead.
async function shutdownTracing() {
  try {
    await sdk.shutdown();
    console.log('Tracing terminated');
  } catch (error) {
    console.log('Error terminating tracing', error);
  }
}

module.exports = { shutdownTracing };
