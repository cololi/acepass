/** Stylesheets are bundled as text (`loader: { '.css': 'text' }`) and injected as `<style>`. */
declare module '*.css' {
  const text: string
  export default text
}
