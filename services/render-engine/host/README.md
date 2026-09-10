# gx-engine-host

Persistent single-instance supervisor. Machine-wide lock, bounded exponential
backoff on worker restart, WAL journal, verified restore.

Restore starts **output-inhibited** and validates the first frame off-air
before anything reaches an audience.
