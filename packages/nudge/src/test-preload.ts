// Quiet test output: @openpanel/db's import-time ClickHouse logs, and kafkajs's own partitioner notice.
process.env.LOG_SILENT ??= 'true';
process.env.KAFKAJS_NO_PARTITIONER_WARNING ??= '1';

// kafkajs 2.2.4 computes a negative timeout in its request queue under Bun; that warning is harmless.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'TimeoutNegativeWarning') {
    console.warn(warning);
  }
});
