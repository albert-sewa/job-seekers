// Platforms without a usable API get "open a pre-filled search" links instead.
import { countryCode } from "./sources/jsearch.js";

const INDEED_DOMAIN = { sg: "sg.indeed.com", my: "malaysia.indeed.com", id: "id.indeed.com", th: "th.indeed.com", vn: "vn.indeed.com", ph: "ph.indeed.com", hk: "hk.indeed.com", au: "au.indeed.com", gb: "uk.indeed.com", us: "www.indeed.com", in: "in.indeed.com" };
const JOBSTREET_DOMAIN = { sg: "sg.jobstreet.com", my: "www.jobstreet.com.my", id: "www.jobstreet.co.id", ph: "www.jobstreet.com.ph" };
const GLASSDOOR_DOMAIN = { sg: "www.glassdoor.sg", my: "www.glassdoor.com", hk: "www.glassdoor.com.hk", au: "www.glassdoor.com.au", gb: "www.glassdoor.co.uk", us: "www.glassdoor.com", in: "www.glassdoor.co.in" };

export function buildDeepLinks({ query, location }) {
  const q = encodeURIComponent(query || "");
  const loc = location || "Singapore";
  const l = encodeURIComponent(loc);
  const cc = countryCode(loc) || "sg";
  const links = [];

  links.push({ id: "jobstreet", label: "JobStreet", url: `https://${JOBSTREET_DOMAIN[cc] || JOBSTREET_DOMAIN.sg}/jobs?keywords=${q}` });
  if (cc === "sg") {
    links.push({ id: "mycareersfuture", label: "MyCareersFuture", url: `https://www.mycareersfuture.gov.sg/search?search=${q}&sortBy=relevancy&page=0` });
  }
  links.push({ id: "linkedin", label: "LinkedIn", url: `https://www.linkedin.com/jobs/search/?keywords=${q}&location=${l}` });
  links.push({ id: "indeed", label: "Indeed", url: `https://${INDEED_DOMAIN[cc] || INDEED_DOMAIN.sg}/jobs?q=${q}&l=${l}` });
  links.push({ id: "glassdoor", label: "Glassdoor", url: `https://${GLASSDOOR_DOMAIN[cc] || GLASSDOOR_DOMAIN.sg}/Job/jobs.htm?sc.keyword=${q}` });
  links.push({ id: "glints", label: "Glints", url: `https://glints.com/${cc === "sg" ? "sg" : cc}/opportunities/jobs/explore?keyword=${q}&country=${cc.toUpperCase()}` });
  links.push({ id: "techinasia", label: "Tech in Asia", url: `https://www.techinasia.com/jobs/search?query=${q}&country_name[]=${l}` });
  links.push({ id: "nodeflair", label: "NodeFlair", url: `https://nodeflair.com/jobs?query=${q}&countries[]=${l}` });
  return links;
}
