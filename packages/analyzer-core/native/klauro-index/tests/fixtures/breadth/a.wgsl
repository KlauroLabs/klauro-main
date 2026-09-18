struct Uniforms {
  scale: f32,
};

fn scaled(value: f32) -> f32 {
  return value * 2.0;
}

@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(scaled(0.5), 0.0, 0.0, 1.0);
}
