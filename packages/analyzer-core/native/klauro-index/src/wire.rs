use std::cell::RefCell;

use rustc_hash::FxHashMap;
use serde::{ser, Serialize, Serializer};

#[derive(Default)]
pub struct Strings {
    values: Vec<String>,
    symbols: FxHashMap<String, u32>,
}

impl Strings {
    fn symbol(&mut self, value: &str) -> u32 {
        if let Some(found) = self.symbols.get(value) {
            return *found;
        }
        let symbol = self.values.len() as u32;
        self.values.push(value.to_string());
        self.symbols.insert(value.to_string(), symbol);
        symbol
    }

    pub fn into_values(self) -> Vec<String> {
        self.values
    }
}

struct Symbol(i64);

impl Symbol {
    fn of(strings: &RefCell<Strings>, value: &str) -> Self {
        Symbol(-1 - i64::from(strings.borrow_mut().symbol(value)))
    }
}

impl Serialize for Symbol {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(self.0)
    }
}

pub struct Interned<'a, T: ?Sized> {
    value: &'a T,
    strings: &'a RefCell<Strings>,
}

impl<'a, T: ?Sized + Serialize> Interned<'a, T> {
    pub fn new(value: &'a T, strings: &'a RefCell<Strings>) -> Self {
        Interned { value, strings }
    }
}

impl<T: ?Sized + Serialize> Serialize for Interned<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value.serialize(Interning { inner: serializer, strings: self.strings })
    }
}

struct Interning<'a, S> {
    inner: S,
    strings: &'a RefCell<Strings>,
}

struct Compound<'a, S> {
    inner: S,
    strings: &'a RefCell<Strings>,
}

macro_rules! forward {
    ($($method:ident($type:ty),)*) => {
        $(fn $method(self, value: $type) -> Result<S::Ok, S::Error> {
            self.inner.$method(value)
        })*
    };
}

macro_rules! compound {
    ($($trait:ident { $method:ident $(, $name:ident)? },)*) => {
        $(impl<S: ser::$trait> ser::$trait for Compound<'_, S> {
            type Ok = S::Ok;
            type Error = S::Error;

            fn $method<T: ?Sized + Serialize>(
                &mut self,
                $($name: &'static str,)?
                value: &T,
            ) -> Result<(), S::Error> {
                self.inner.$method($($name,)? &Interned::new(value, self.strings))
            }

            fn end(self) -> Result<S::Ok, S::Error> {
                self.inner.end()
            }
        })*
    };
}

compound! {
    SerializeSeq { serialize_element },
    SerializeTuple { serialize_element },
    SerializeTupleStruct { serialize_field },
    SerializeTupleVariant { serialize_field },
}

macro_rules! named {
    ($($trait:ident,)*) => {
        $(impl<S: ser::SerializeMap> ser::$trait for Compound<'_, S> {
            type Ok = S::Ok;
            type Error = S::Error;

            fn serialize_field<T: ?Sized + Serialize>(
                &mut self,
                key: &'static str,
                value: &T,
            ) -> Result<(), S::Error> {
                self.inner
                    .serialize_entry(&Symbol::of(self.strings, key), &Interned::new(value, self.strings))
            }

            fn end(self) -> Result<S::Ok, S::Error> {
                self.inner.end()
            }
        })*
    };
}

named! {
    SerializeStruct,
    SerializeStructVariant,
}

impl<S: ser::SerializeMap> ser::SerializeMap for Compound<'_, S> {
    type Ok = S::Ok;
    type Error = S::Error;

    fn serialize_key<T: ?Sized + Serialize>(&mut self, key: &T) -> Result<(), S::Error> {
        self.inner.serialize_key(&Interned::new(key, self.strings))
    }

    fn serialize_value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), S::Error> {
        self.inner.serialize_value(&Interned::new(value, self.strings))
    }

    fn end(self) -> Result<S::Ok, S::Error> {
        self.inner.end()
    }
}

impl<'a, S: Serializer> Serializer for Interning<'a, S> {
    type Ok = S::Ok;
    type Error = S::Error;
    type SerializeSeq = Compound<'a, S::SerializeSeq>;
    type SerializeTuple = Compound<'a, S::SerializeTuple>;
    type SerializeTupleStruct = Compound<'a, S::SerializeTupleStruct>;
    type SerializeTupleVariant = Compound<'a, S::SerializeTupleVariant>;
    type SerializeMap = Compound<'a, S::SerializeMap>;
    type SerializeStruct = Compound<'a, S::SerializeMap>;
    type SerializeStructVariant = Compound<'a, S::SerializeMap>;

    forward! {
        serialize_bool(bool),
        serialize_u8(u8),
        serialize_u16(u16),
        serialize_u32(u32),
        serialize_u64(u64),
        serialize_f32(f32),
        serialize_f64(f64),
        serialize_char(char),
        serialize_bytes(&[u8]),
    }

    fn serialize_i8(self, value: i8) -> Result<S::Ok, S::Error> {
        self.serialize_i64(i64::from(value))
    }

    fn serialize_i16(self, value: i16) -> Result<S::Ok, S::Error> {
        self.serialize_i64(i64::from(value))
    }

    fn serialize_i32(self, value: i32) -> Result<S::Ok, S::Error> {
        self.serialize_i64(i64::from(value))
    }

    fn serialize_i64(self, value: i64) -> Result<S::Ok, S::Error> {
        match value < 0 {
            true => self.inner.serialize_f64(value as f64),
            false => self.inner.serialize_u64(value as u64),
        }
    }

    fn serialize_str(self, value: &str) -> Result<S::Ok, S::Error> {
        Symbol::of(self.strings, value).serialize(self.inner)
    }

    fn serialize_none(self) -> Result<S::Ok, S::Error> {
        self.inner.serialize_none()
    }

    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<S::Ok, S::Error> {
        self.inner.serialize_some(&Interned::new(value, self.strings))
    }

    fn serialize_unit(self) -> Result<S::Ok, S::Error> {
        self.inner.serialize_unit()
    }

    fn serialize_unit_struct(self, name: &'static str) -> Result<S::Ok, S::Error> {
        self.inner.serialize_unit_struct(name)
    }

    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result<S::Ok, S::Error> {
        Symbol::of(self.strings, variant).serialize(self.inner)
    }

    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result<S::Ok, S::Error> {
        self.inner.serialize_newtype_struct(name, &Interned::new(value, self.strings))
    }

    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        name: &'static str,
        index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<S::Ok, S::Error> {
        self.inner.serialize_newtype_variant(
            name,
            index,
            variant,
            &Interned::new(value, self.strings),
        )
    }

    fn serialize_seq(self, length: Option<usize>) -> Result<Self::SerializeSeq, S::Error> {
        Ok(Compound { inner: self.inner.serialize_seq(length)?, strings: self.strings })
    }

    fn serialize_tuple(self, length: usize) -> Result<Self::SerializeTuple, S::Error> {
        Ok(Compound { inner: self.inner.serialize_tuple(length)?, strings: self.strings })
    }

    fn serialize_tuple_struct(
        self,
        name: &'static str,
        length: usize,
    ) -> Result<Self::SerializeTupleStruct, S::Error> {
        Ok(Compound {
            inner: self.inner.serialize_tuple_struct(name, length)?,
            strings: self.strings,
        })
    }

    fn serialize_tuple_variant(
        self,
        name: &'static str,
        index: u32,
        variant: &'static str,
        length: usize,
    ) -> Result<Self::SerializeTupleVariant, S::Error> {
        Ok(Compound {
            inner: self.inner.serialize_tuple_variant(name, index, variant, length)?,
            strings: self.strings,
        })
    }

    fn serialize_map(self, length: Option<usize>) -> Result<Self::SerializeMap, S::Error> {
        Ok(Compound { inner: self.inner.serialize_map(length)?, strings: self.strings })
    }

    fn serialize_struct(
        self,
        _name: &'static str,
        length: usize,
    ) -> Result<Self::SerializeStruct, S::Error> {
        Ok(Compound { inner: self.inner.serialize_map(Some(length))?, strings: self.strings })
    }

    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        _variant: &'static str,
        length: usize,
    ) -> Result<Self::SerializeStructVariant, S::Error> {
        Ok(Compound { inner: self.inner.serialize_map(Some(length))?, strings: self.strings })
    }
}
