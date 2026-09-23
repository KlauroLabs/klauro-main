export const actions = {
  default: async ({ cookies, request }) => {
    const data = await request.formData();
    cookies.set('session', data.get('token'), { path: '/' });
  },
};
