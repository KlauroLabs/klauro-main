__global__ void scale(float *out, const float *in, float k) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  out[i] = in[i] * k;
}

void launch(float *out, const float *in) {
  scale<<<16, 256>>>(out, in, 2.0f);
}
