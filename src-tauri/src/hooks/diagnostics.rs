// Diagnostics — Ring buffer of the last 100 diagnostic events for observability

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const RING_BUFFER_CAPACITY: usize = 100;

/// Severity level of a diagnostic event
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Debug,
    Info,
    Warning,
    Error,
}

/// A single diagnostic event stored in the ring buffer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticEvent {
    /// Monotonic sequence number (never reused within a session)
    pub seq: u64,
    /// Unix timestamp (milliseconds)
    pub timestamp_ms: u64,
    pub severity: DiagnosticSeverity,
    /// Component that emitted the event (e.g. "terminal", "webhook", "remote")
    pub component: String,
    pub message: String,
    /// Optional structured payload
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// Fixed-capacity ring buffer for diagnostic events.
/// Oldest entries are evicted when capacity is reached.
/// Thread-safe via internal mutex.
#[derive(Clone)]
pub struct DiagnosticRingBuffer {
    inner: Arc<Mutex<RingBufferInner>>,
}

struct RingBufferInner {
    events: VecDeque<DiagnosticEvent>,
}

impl DiagnosticRingBuffer {
    pub fn new() -> Self {
        Self::with_capacity(RING_BUFFER_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RingBufferInner {
                events: VecDeque::with_capacity(capacity),
            })),
        }
    }

    /// Snapshot of all events (oldest first)
    pub fn all(&self) -> Vec<DiagnosticEvent> {
        let inner = self.inner.lock().unwrap();
        inner.events.iter().cloned().collect()
    }
}

impl Default for DiagnosticRingBuffer {
    fn default() -> Self {
        Self::new()
    }
}
