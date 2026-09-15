struct Light { vec3 pos; };
vec4 shade(vec3 n) { return vec4(compute(n), 1.0); }
