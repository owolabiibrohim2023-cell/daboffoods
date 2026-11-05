import { esc, waLink } from "./app.js";

// Editable catalogue: add confirmed prices or packaging only after the business supplies them.
const FOOD_IMAGE = "https://images.unsplash.com/";
export const FOOD_PRODUCTS = [
  { name: "Dried Crayfish", description: "A traditional Nigerian ingredient used to add rich flavour to soups and stews.", icon: "fa-shrimp", image: `${FOOD_IMAGE}photo-1510130387422-82bed34b37e9?q=80&w=1000&auto=format&fit=crop`, alt: "Dried seafood and food ingredients" },
  { name: "Dried Fish", description: "A flavourful dried fish option for a variety of traditional Nigerian dishes.", icon: "fa-fish", image: `${FOOD_IMAGE}photo-1519708227418-c8fd9a32b7a2?q=80&w=1000&auto=format&fit=crop`, alt: "Fish prepared as a food ingredient" },
  { name: "Garri", description: "A familiar Nigerian staple made from cassava and enjoyed in many ways.", icon: "fa-bowl-food", image: `${FOOD_IMAGE}photo-1604329760661-e71dc83f8f26?q=80&w=1000&auto=format&fit=crop`, alt: "Traditional staple food ingredients" },
  { name: "Egusi", description: "Melon seeds commonly used to prepare classic Nigerian egusi soup.", icon: "fa-seedling", image: `${FOOD_IMAGE}photo-1604908176997-125f25cc6f3d?q=80&w=1000&auto=format&fit=crop`, alt: "Seeds and ingredients for Nigerian cooking" },
  { name: "Ogbono", description: "A traditional seed ingredient used to prepare Nigerian ogbono soup.", icon: "fa-seedling", image: `${FOOD_IMAGE}photo-1596040033229-a9821ebd058d?q=80&w=1000&auto=format&fit=crop`, alt: "Traditional spices and dried ingredients" },
  { name: "Dried Pepper", description: "Dried pepper for adding warmth and flavour to traditional meals.", icon: "fa-pepper-hot", image: `${FOOD_IMAGE}photo-1583663848850-46af132dc08e?q=80&w=1000&auto=format&fit=crop`, alt: "Dried peppers and spices" },
  { name: "Stockfish", description: "A traditional dried fish ingredient used in Nigerian soups and stews.", icon: "fa-fish-fins", image: `${FOOD_IMAGE}photo-1535399831218-d5bd36d1a6b3?q=80&w=1000&auto=format&fit=crop`, alt: "Dried fish ingredient for cooking" },
  { name: "Beans", description: "A versatile Nigerian pantry staple for everyday meals and traditional recipes.", icon: "fa-seedling", image: `${FOOD_IMAGE}photo-1515543904379-3d757afe72e4?q=80&w=1000&auto=format&fit=crop`, alt: "Beans and pulses for traditional meals" },
  { name: "Other Traditional Nigerian Food Products", description: "Looking for another traditional food product? Contact us to ask about sourcing and order options.", icon: "fa-basket-shopping", image: `${FOOD_IMAGE}photo-1547592180-85f173990554?q=80&w=1000&auto=format&fit=crop`, alt: "A selection of food ingredients" }
];

export function productEnquiryMessage(productName) {
  return `Hello DABOFFOODS & LOGISTICS SERVICES, I am interested in purchasing ${productName.toLowerCase()}. Please let me know the available quantities, prices and delivery options.`;
}

export function renderProductCards(container, products = FOOD_PRODUCTS) {
  if (!container) return;
  container.innerHTML = products.map(product => `
    <article class="food-card">
      <div class="food-card-image">
        <img loading="lazy" src="${product.image}" alt="${esc(product.alt || product.name)}">
      </div>
      <div class="food-card-body">
        <span class="food-card-label"><i class="fa-solid ${esc(product.icon)}" aria-hidden="true"></i> Nigerian food product</span>
        <h3>${esc(product.name)}</h3>
        <p>${esc(product.description)}</p>
        <a class="btn btn-wa" href="${waLink(productEnquiryMessage(product.name))}" target="_blank" rel="noopener">
          <i class="fa-brands fa-whatsapp" aria-hidden="true"></i> Order / Enquire
        </a>
      </div>
    </article>`).join("");

  container.querySelectorAll("img").forEach(image => image.addEventListener("error", () => {
    if (image.dataset.fallbackApplied) return;
    image.dataset.fallbackApplied = "true";
    image.src = `${FOOD_IMAGE}photo-1547592180-85f173990554?q=80&w=1000&auto=format&fit=crop`;
  }));
}

export const BULK_ORDER_MESSAGE = "Hello DABOFFOODS, I am interested in purchasing Nigerian food products in bulk. Please share your available products, wholesale prices and minimum order quantities.";
export const FOOD_EXPORT_MESSAGE = "Hello DABOFFOODS & LOGISTICS SERVICES, I am interested in exporting Nigerian food products to my country. Please provide your available products, export requirements, shipping options and quotation.";
