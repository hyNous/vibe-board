use serde_json::{Map, Value};
use std::collections::HashSet;

pub fn disabled_skill_paths(config: &Value) -> HashSet<String> {
    config
        .get("skill")
        .and_then(Value::as_object)
        .map(|skills| {
            skills
                .iter()
                .filter(|(_, value)| value.get("enable").and_then(Value::as_bool) == Some(false))
                .map(|(path, _)| path.clone())
                .collect()
        })
        .unwrap_or_default()
}

pub fn skill_overrides_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    root_object_mut(config)?
        .entry("skill")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "ZCode skill config is not an object".to_string())
}

fn root_object_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    config
        .as_object_mut()
        .ok_or_else(|| "ZCode config is not an object".to_string())
}
