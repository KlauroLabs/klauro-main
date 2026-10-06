mod common;

use common::calls;

#[test]
fn a_call_on_a_typed_parameter_reaches_that_types_method() {
    let index = common::read("dart_calls");
    assert!(calls(&index, "archiver.dart:function:archive", "account.dart:function:save"));
    assert!(calls(&index, "service.dart:function:persist", "account.dart:function:save"));
    assert!(calls(&index, "loguser.dart:function:logIt", "logger.dart:function:save"));
    assert!(!calls(&index, "loguser.dart:function:logIt", "account.dart:function:save"));
}
