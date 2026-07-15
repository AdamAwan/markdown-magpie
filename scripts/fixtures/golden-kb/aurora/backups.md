# Backups

Aurora takes automatic backups of every cluster. This page covers the backup
schedule and the retention policy.

## Backup schedule

Nightly backups run at 02:00 UTC for every Aurora cluster. A manual backup can
be triggered at any time from the console.

## Backup retention

How long a backup is retained: nightly database backups are retained for 35
days. After 35 days a backup expires and is deleted permanently. Retained
backups can be restored to a new cluster from the console.
