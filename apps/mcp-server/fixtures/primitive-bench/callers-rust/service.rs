use crate::account::Account;
pub fn persist(a: &Account) {
    a.save();
}
