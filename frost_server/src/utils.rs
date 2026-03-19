//! Shared utilities for poison recovery on sync primitives.

use std::sync::{MutexGuard, PoisonError, RwLockReadGuard, RwLockWriteGuard};

pub fn recover_read<T>(err: PoisonError<RwLockReadGuard<'_, T>>) -> RwLockReadGuard<'_, T> {
    tracing::warn!("RwLock poisoned (read), recovering");
    err.into_inner()
}

pub fn recover_write<T>(err: PoisonError<RwLockWriteGuard<'_, T>>) -> RwLockWriteGuard<'_, T> {
    tracing::warn!("RwLock poisoned (write), recovering");
    err.into_inner()
}

pub fn recover_mutex<T>(err: PoisonError<MutexGuard<'_, T>>) -> MutexGuard<'_, T> {
    tracing::warn!("Mutex poisoned, recovering");
    err.into_inner()
}
