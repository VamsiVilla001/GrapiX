//! 2.18: the installed closure is called with the event that came, inside the
//! call the system makes, and a second handler is refused. One test, because
//! the handler is one per process. No event is raised on the console (the test
//! runner shares it); the real delivery is the live check in `docs/evidence/2.18`.

use std::sync::{Arc, Mutex};

use gx_console_stop::{deliver, on_console_event, ConsoleEvent, InstallError};

#[test]
fn the_closure_gets_each_event_before_the_handler_returns_and_a_second_is_refused() {
    // Nothing installed yet: an event is not handled.
    assert!(!deliver(2));

    let seen: Arc<Mutex<Vec<ConsoleEvent>>> = Arc::default();
    let sink = Arc::clone(&seen);
    on_console_event(move |event| {
        if event == ConsoleEvent::Shutdown {
            panic!("a closure that panics must not unwind into the system");
        }
        sink.lock().expect("lock").push(event);
    })
    .expect("the first handler installs");

    // Handled, and the closure has already run when `deliver` returns.
    assert!(deliver(2));
    assert_eq!(*seen.lock().expect("lock"), [ConsoleEvent::Close]);
    assert!(deliver(0));
    assert!(deliver(1));
    assert!(deliver(5));
    assert_eq!(
        *seen.lock().expect("lock"),
        [
            ConsoleEvent::Close,
            ConsoleEvent::CtrlC,
            ConsoleEvent::CtrlBreak,
            ConsoleEvent::Logoff
        ]
    );
    // A reserved code is left to the next handler and the closure is not called.
    assert!(!deliver(3));
    // A panic is caught and the event is reported as not handled.
    assert!(!deliver(6));
    assert_eq!(seen.lock().expect("lock").len(), 4);

    let again = on_console_event(|_| {});
    assert!(matches!(again, Err(InstallError::AlreadyInstalled)));
    // The first closure is still the one installed.
    assert!(deliver(2));
    assert_eq!(seen.lock().expect("lock").len(), 5);
}
