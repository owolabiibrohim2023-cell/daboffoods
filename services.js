import { esc } from "./app.js";

// Edit this array to update service names, copy, imagery or icons across both service views.
const SERVICE_IMAGE = "https://images.unsplash.com/";
export const SERVICES = [
  {
    title: "Nigerian Food Products & Sales",
    description: "Discover authentic Nigerian food products, traditional ingredients and dried food items available for individual purchases, wholesale supply and international orders.",
    icon: "fa-basket-shopping",
    image: `${SERVICE_IMAGE}photo-1547592180-85f173990554?q=80&w=1000&auto=format&fit=crop`,
    alt: "Traditional food ingredients prepared for sale"
  },
  {
    title: "Food Export Services",
    description: "We help individuals and businesses source Nigerian food products for international export, connecting authentic Nigerian products with customers across the world.",
    icon: "fa-earth-africa",
    image: `${SERVICE_IMAGE}photo-1606787366850-de6330128bfc?q=80&w=1000&auto=format&fit=crop`,
    alt: "Food products being prepared for international export"
  },
  {
    title: "International Shipping",
    description: "Access international express delivery and shipping solutions through our trusted international carrier partners.",
    icon: "fa-plane",
    image: `${SERVICE_IMAGE}photo-1566576721346-d4a3b4eaeb55?q=80&w=1000&auto=format&fit=crop`,
    alt: "Parcels prepared for international shipping"
  },
  {
    title: "Freight Forwarding",
    description: "Reliable freight forwarding solutions for individuals and businesses shipping goods internationally.",
    icon: "fa-truck-ramp-box",
    image: `${SERVICE_IMAGE}photo-1586528116311-ad8dd3c8310d?q=80&w=1000&auto=format&fit=crop`,
    alt: "Freight cargo prepared for forwarding"
  },
  {
    title: "UK & USA Cargo Services",
    description: "We offer international cargo shipping solutions to the United Kingdom and United States, with convenient doorstep delivery options.",
    icon: "fa-earth-americas",
    image: `${SERVICE_IMAGE}photo-1601584115197-04ecc0da31d7?q=80&w=1000&auto=format&fit=crop`,
    alt: "Cargo truck transporting goods"
  },
  {
    title: "Customs Clearance Support",
    description: "Get assistance with customs clearance processes at destination countries through our international logistics arrangements.",
    icon: "fa-file-circle-check",
    image: `${SERVICE_IMAGE}photo-1450101499163-c8848c66ca85?q=80&w=1000&auto=format&fit=crop`,
    alt: "Shipping documents ready for review"
  },
  {
    title: "Doorstep Delivery",
    description: "Enjoy convenient international delivery solutions designed to bring shipments directly to the recipient's address.",
    icon: "fa-house-circle-check",
    image: `${SERVICE_IMAGE}photo-1553413077-190dd305871c?q=80&w=1000&auto=format&fit=crop`,
    alt: "Packages organized for delivery"
  }
];

export function renderServiceCards(container, services = SERVICES) {
  if (!container) return;
  container.innerHTML = services.map(service => {
    const serviceQuery = encodeURIComponent(service.title);
    return `
      <article class="lp-svc">
        <div class="lp-svc-img">
          <img loading="lazy" src="${service.image}" alt="${esc(service.alt)}">
        </div>
        <div class="lp-svc-body">
          <h3><i class="fa-solid ${esc(service.icon)}" aria-hidden="true"></i> ${esc(service.title)}</h3>
          <p class="muted" style="margin-top:8px">${esc(service.description)}</p>
          <a class="btn btn-blue btn-block" href="book.html?service=${serviceQuery}">
            <i class="fa-solid fa-box" aria-hidden="true"></i> Book this service
          </a>
        </div>
      </article>`;
  }).join("");
}
