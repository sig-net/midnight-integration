//! Strict recursive descriptor validation, mirroring the TypeScript twin: a
//! malformed descriptor must fail immediately with a path to the offending
//! node, never produce bytes.

use std::collections::HashSet;

use crate::error::Error;
use crate::types::{Descriptor, MAX_UINT_BITS};
use crate::u256::U256;

/// Assert that a descriptor is structurally valid, recursively. Rejects
/// out-of-range widths and bounds, zero or negative enum variant counts, and
/// empty or duplicate struct field names.
pub fn validate(descriptor: &Descriptor) -> Result<(), Error> {
    validate_at(descriptor, "type")
}

fn validate_at(descriptor: &Descriptor, path: &str) -> Result<(), Error> {
    match descriptor {
        Descriptor::Boolean | Descriptor::Field | Descriptor::Bytes { .. } => Ok(()),
        Descriptor::UintBits { bits } => {
            if *bits < 1 || *bits > MAX_UINT_BITS {
                return Err(Error::InvalidDescriptor {
                    path: path.to_string(),
                    reason: format!("uint bits must be in 1..{MAX_UINT_BITS}, got {bits}"),
                });
            }
            Ok(())
        }
        Descriptor::UintBound { bound } => {
            let max_bound = U256::pow2(MAX_UINT_BITS);
            if bound < &U256::ONE || bound > &max_bound {
                return Err(Error::InvalidDescriptor {
                    path: path.to_string(),
                    reason: format!(
                        "uint bound must be in 1..2^{MAX_UINT_BITS} (the bound is EXCLUSIVE), got {bound}"
                    ),
                });
            }
            Ok(())
        }
        Descriptor::Enum { variants } => {
            if *variants < 1 {
                return Err(Error::InvalidDescriptor {
                    path: path.to_string(),
                    reason: "enum variants must be 1 or more".to_string(),
                });
            }
            Ok(())
        }
        Descriptor::Vector { element, .. } => validate_at(element, &format!("{path}.element")),
        Descriptor::Tuple { elements } => {
            for (i, element) in elements.iter().enumerate() {
                validate_at(element, &format!("{path}.elements[{i}]"))?;
            }
            Ok(())
        }
        Descriptor::Struct { fields } => {
            let mut seen: HashSet<&str> = HashSet::new();
            for (i, (name, field)) in fields.iter().enumerate() {
                let field_path = format!("{path}.fields[{i}]");
                if name.is_empty() {
                    return Err(Error::InvalidDescriptor {
                        path: field_path,
                        reason: "field name must be non-empty".to_string(),
                    });
                }
                if !seen.insert(name.as_str()) {
                    return Err(Error::InvalidDescriptor {
                        path: field_path,
                        reason: format!("duplicate field name '{name}'"),
                    });
                }
                validate_at(field, &format!("{field_path}.type"))?;
            }
            Ok(())
        }
    }
}
