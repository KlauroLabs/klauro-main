shader_type canvas_item;

float scale(float value) {
	return value * 2.0;
}

void fragment() {
	COLOR.r = scale(0.5);
}
