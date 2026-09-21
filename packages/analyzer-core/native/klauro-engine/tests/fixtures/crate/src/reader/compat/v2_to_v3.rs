use super::v1_to_v2::CompatV1ToV2;
use crate::reader::Reader;
use crate::Outcome;

pub fn upgrade(reader: Reader, earlier: CompatV1ToV2) -> Outcome {
    let _ = (reader, earlier);
    Ok(())
}
