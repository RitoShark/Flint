# WAD browser troubleshooting

## Windows crashes while loading WAD files

A reported case on a WD_BLACK SN770 2TB stopped after updating its firmware from
731100WD to 731130WD. Windows recorded KERNEL_DATA_INPAGE_ERROR,
UNEXPECTED_STORE_EXCEPTION and CRITICAL_PROCESS_DIED, alongside NVMe controller
errors and failed crash-dump writes.

SanDisk documents a Host Memory Buffer firmware issue affecting certain SSDs on
Windows 11 24H2, including this model. Check the exact model and follow the
[SanDisk firmware update instructions](https://support-en.sandisk.com/app/answers/detailweb/a_id/51469).
Back up important data before updating firmware, as the vendor recommends.

Flint reads WAD headers through buffered file I/O. Its hash database uses LMDB,
which is memory-mapped. Background indexing submits one batch at a time, and
the backend serializes indexing requests and WAD header reads. An indexing
error stops later batches and is displayed in the browser; there is no automatic
retry. Leaving the browser stops scheduling further batches and discards late
results. An already-running backend batch can still finish.

These limits reduce disk pressure but cannot repair SSD firmware or catch a
Windows kernel crash. A stalled operating-system read may also remain blocked.
If crashes continue, include the Flint version, Windows build, SSD model and
firmware, and the relevant Windows System event log entries in a bug report.
