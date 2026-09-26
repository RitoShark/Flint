use flint_hash::error::{Error, Result};

#[derive(Clone)]
pub struct DownloadCancellation(tokio::sync::watch::Sender<bool>);

impl Default for DownloadCancellation {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }
}

impl DownloadCancellation {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }

    pub fn check(&self) -> Result<()> {
        if *self.0.borrow() {
            Err(Error::Cdn("Download aborted".into()))
        } else {
            Ok(())
        }
    }

    pub async fn run<F: std::future::Future>(&self, work: F) -> Result<F::Output> {
        let mut receiver = self.0.subscribe();
        tokio::select! {
            biased;
            _ = receiver.wait_for(|cancelled| *cancelled) => Err(Error::Cdn("Download aborted".into())),
            result = work => Ok(result),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_before_start_never_polls_work() {
        let cancel = DownloadCancellation::default();
        cancel.cancel();
        assert!(cancel.run(async { panic!("cancelled work ran") }).await.is_err());
    }

    #[tokio::test]
    async fn cancellation_drops_active_work_and_is_isolated() {
        let cancel = DownloadCancellation::default();
        let other = DownloadCancellation::default();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (dropped, cleanup) = tokio::sync::oneshot::channel::<()>();
        let worker = cancel.clone();
        let task = tokio::spawn(async move {
            worker.run(async move {
                let _dropped = dropped;
                started.send(()).unwrap();
                std::future::pending::<()>().await;
            }).await
        });
        ready.await.unwrap();
        cancel.cancel();
        assert!(task.await.unwrap().is_err());
        assert!(cleanup.await.is_err());
        assert_eq!(other.run(async { 42 }).await.unwrap(), 42);
    }
}
