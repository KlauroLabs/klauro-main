use crate::account::Account;
pub fn archive(a: &Account) {
    a.save();
}
